//
//  ViewController.m
//  ClaudePatcher
//
//  Created by Efimov.mg on 23/2/2026.
//
#import <objc/runtime.h>
#import <objc/message.h>
#import <CommonCrypto/CommonDigest.h>
#import "ViewController.h"
#import "PolyfillsLoader.h"
#import "LoadingOverlayView.h"

#import <WebKit/WebKit.h>
#import <SafariServices/SafariServices.h>
#import <AVFoundation/AVFoundation.h>

/// Background behind the web page, matching claude.ai's own theme colours
/// (#FCFCFB light, #151515 dark) so no off-colour band shows while it loads.
static UIColor *AppBackgroundColor(void) {
    return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *tc) {
        return tc.userInterfaceStyle == UIUserInterfaceStyleDark
        ? [UIColor colorWithRed:0x15/255.0 green:0x15/255.0 blue:0x15/255.0 alpha:1.0]
        : [UIColor colorWithRed:0xFC/255.0 green:0xFC/255.0 blue:0xFB/255.0 alpha:1.0];
    }];
}

/// Number of modules the previous successful launch had to transpile — used to
/// turn the module counter into a real percentage on every launch but the first.
static NSString *const kModuleCountKey = @"LastModuleCount";

/// Last edge colours reported by the page ({top: {r,g,b}, bottom: {r,g,b}}).
static NSString *const kEdgeColoursKey = @"LastEdgeColours";

/// Seconds without any module activity before the page is assumed to be ready.
static const NSTimeInterval kSettleAfterReadySignal = 0.3;
static const NSTimeInterval kSettleWithoutReadySignal = 6.0;
/// Claude paints seconds after the last module runs — on claude.ai the first text
/// appears around 15s in, far later than module activity settles, and much later
/// still on an older device. So a JS error logged along the way must not be called
/// a failure until the app has really had time to show something.
/// A module that failed to execute never registered its exports, so everything
/// importing it stays blocked — once activity stops there is nothing left to wait
/// for, and no paint is coming.
static const NSTimeInterval kSettleAfterModuleFailure = 2.5;
static const NSTimeInterval kMinimumElapsedBeforeErrorScreen = 30.0;
/// Hard stop: never keep the overlay up longer than this.
static const NSTimeInterval kLoadingTimeout = 60.0;

#pragma mark - Settings and the event log

/// Settings from the three-finger menu. Fast loading and the tap fix default to
/// on; page size defaults to 110 %.
static NSString *const kFastLoadKey = @"FastLoading";
static NSString *const kTapFixKey = @"TapFix";
static NSString *const kNativeChromeKey = @"NativeControls";
static NSString *const kPageScaleKey = @"PageScale";
/// Detailed measurements for the debug log (off by default: they cost time on
/// every launch and tap).
static NSString *const kDiagnosticsKey = @"Diagnostics";

/// Events worth keeping across reloads and launches (sign-outs, the page process
/// being stopped by iOS, session cookie changes, launch times). Shown at the top
/// of the copied debug log.
static NSString *const kEventLogKey = @"AppEventLog";
static const NSUInteger kEventLogLimit = 200;

/// Copy of claude.ai's persistent cookies, see -saveSessionCookies:.
static NSString *const kSessionBackupFile = @"session-cookies.plist";

/// A claude.ai address the app was asked to open before the page was set up.
static NSURL *gQueuedAppURL = nil;

static BOOL SettingBool(NSString *key, BOOL fallback) {
    id value = [NSUserDefaults.standardUserDefaults objectForKey:key];
    return [value isKindOfClass:NSNumber.class] ? [value boolValue] : fallback;
}

static double PageScaleSetting(void) {
    id value = [NSUserDefaults.standardUserDefaults objectForKey:kPageScaleKey];
    double scale = [value isKindOfClass:NSNumber.class] ? [value doubleValue] : 1.1;
    return MIN(MAX(scale, 1.0), 1.25);
}

/// First six hex digits of a SHA-256: enough to tell two cookie values apart in
/// the log, nothing that could be used as the value.
static NSString *ShortFingerprint(NSString *value) {
    NSData *data = [value ?: @"" dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    return [NSString stringWithFormat:@"#%02x%02x%02x", digest[0], digest[1], digest[2]];
}

/// Messages are accepted only from claude.ai's own top-level page, see
/// -isTrustedMessage:.
static BOOL IsTrustedFrame(WKFrameInfo *frame) {
    WKSecurityOrigin *origin = frame.securityOrigin;
    return frame.isMainFrame
        && [origin.protocol isEqualToString:@"https"]
        && [origin.host.lowercaseString isEqualToString:@"claude.ai"]
        && origin.port == 0;
}

#pragma mark - Module store

/// Transpiled claude.ai modules, kept as files in the app's Caches folder
/// instead of claude.ai's web storage (CacheStorage), whose quota they filled and
/// which took seconds to open at every launch. The page asks through the
/// "moduleStore" handler and gets an answer back (iOS 14 and later):
///   {op: "get", dir, keys: [address, ...]} -> [code or null, ...]
///   {op: "put", dir, key: address, code}   -> true
///   {op: "prune", dir, keep: [address, ...]} -> {removed, files, bytes}
/// dir names the transpiler version (one folder each; prune removes the
/// others). A file is named by the SHA-256 of its https address, so no
/// address can name a path. Only claude.ai's top-level page is answered.
API_AVAILABLE(ios(14.0))
@interface ModuleStore : NSObject <WKScriptMessageHandlerWithReply>
@end

@implementation ModuleStore {
    dispatch_queue_t _queue;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        // Reads run side by side; writes and pruning run alone.
        _queue = dispatch_queue_create("ClaudeLegacy.moduleStore", DISPATCH_QUEUE_CONCURRENT);
    }
    return self;
}

+ (NSURL *)rootURL {
    NSURL *caches = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                          inDomains:NSUserDomainMask] firstObject];
    return [caches URLByAppendingPathComponent:@"transpiled-modules" isDirectory:YES];
}

/// The folder for one transpiler version, or nil for a name that is not plain.
+ (NSURL *)folderNamed:(id)name {
    if (![name isKindOfClass:NSString.class]) {
        return nil;
    }
    NSString *text = name;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
                               @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"];
    if (text.length == 0 || text.length > 64 || [text hasPrefix:@"."]
        || [text rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) {
        return nil;
    }
    return [[self rootURL] URLByAppendingPathComponent:text isDirectory:YES];
}

/// The file name for a module address, or nil if it is not an https address.
+ (NSString *)fileNameForKey:(id)key {
    if (![key isKindOfClass:NSString.class]) {
        return nil;
    }
    NSString *text = key;
    if (![text hasPrefix:@"https://"] || text.length > 2048) {
        return nil;
    }
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *fileName = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2 + 3];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        [fileName appendFormat:@"%02x", digest[i]];
    }
    [fileName appendString:@".js"];
    return fileName;
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id _Nullable reply, NSString * _Nullable errorMessage))replyHandler
{
    if (!IsTrustedFrame(message.frameInfo) || ![message.body isKindOfClass:NSDictionary.class]) {
        replyHandler(nil, @"refused");
        return;
    }
    NSDictionary *body = message.body;
    NSString *op = [body[@"op"] isKindOfClass:NSString.class] ? body[@"op"] : @"";
    NSURL *folder = [ModuleStore folderNamed:body[@"dir"]];
    if (folder == nil) {
        replyHandler(nil, @"bad folder name");
        return;
    }
    void (^reply)(id, NSString *) = ^(id value, NSString *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            replyHandler(value, error);
        });
    };

    if ([op isEqualToString:@"get"]) {
        NSArray *keys = [body[@"keys"] isKindOfClass:NSArray.class] ? body[@"keys"] : @[];
        dispatch_async(_queue, ^{
            NSMutableArray *codes = [NSMutableArray arrayWithCapacity:keys.count];
            for (id key in keys) {
                NSString *fileName = [ModuleStore fileNameForKey:key];
                NSString *code = nil;
                if (fileName) {
                    code = [NSString stringWithContentsOfURL:[folder URLByAppendingPathComponent:fileName]
                                                    encoding:NSUTF8StringEncoding
                                                       error:nil];
                }
                [codes addObject:code ? (id)code : (id)[NSNull null]];
            }
            reply(codes, nil);
        });
        return;
    }

    if ([op isEqualToString:@"put"]) {
        NSString *fileName = [ModuleStore fileNameForKey:body[@"key"]];
        id code = body[@"code"];
        if (fileName == nil || ![code isKindOfClass:NSString.class]) {
            replyHandler(nil, @"bad module");
            return;
        }
        dispatch_barrier_async(_queue, ^{
            NSError *error = nil;
            [NSFileManager.defaultManager createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
            BOOL ok = [(NSString *)code writeToURL:[folder URLByAppendingPathComponent:fileName]
                                        atomically:YES
                                          encoding:NSUTF8StringEncoding
                                             error:&error];
            reply(@(ok), ok ? nil : (error.localizedDescription ?: @"write failed"));
        });
        return;
    }

    if ([op isEqualToString:@"prune"]) {
        NSArray *keep = [body[@"keep"] isKindOfClass:NSArray.class] ? body[@"keep"] : @[];
        if (keep.count == 0) {
            replyHandler(nil, @"empty keep list");
            return;
        }
        dispatch_barrier_async(_queue, ^{
            NSFileManager *files = NSFileManager.defaultManager;
            NSMutableSet *keepNames = [NSMutableSet setWithCapacity:keep.count];
            for (id key in keep) {
                NSString *fileName = [ModuleStore fileNameForKey:key];
                if (fileName) {
                    [keepNames addObject:fileName];
                }
            }
            // Folders of other transpiler versions go entirely.
            NSArray<NSURL *> *folders = [files contentsOfDirectoryAtURL:[ModuleStore rootURL]
                                             includingPropertiesForKeys:nil
                                                                options:0
                                                                  error:nil];
            for (NSURL *other in folders) {
                if (![other.lastPathComponent isEqualToString:folder.lastPathComponent]) {
                    [files removeItemAtURL:other error:nil];
                }
            }
            NSInteger removed = 0;
            NSInteger count = 0;
            long long bytes = 0;
            NSArray<NSURL *> *entries = [files contentsOfDirectoryAtURL:folder
                                             includingPropertiesForKeys:@[NSURLFileSizeKey]
                                                                options:0
                                                                  error:nil];
            for (NSURL *entry in entries) {
                if (![keepNames containsObject:entry.lastPathComponent]) {
                    if ([files removeItemAtURL:entry error:nil]) {
                        removed += 1;
                    }
                    continue;
                }
                id size = nil;
                [entry getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
                count += 1;
                if ([size isKindOfClass:NSNumber.class]) {
                    bytes += [(NSNumber *)size longLongValue];
                }
            }
            reply(@{@"removed": @(removed), @"files": @(count), @"bytes": @(bytes)}, nil);
        });
        return;
    }

    replyHandler(nil, @"unknown operation");
}

@end

#pragma mark - Native controls

static UIImage *SymbolImage(NSString *name, CGFloat pointSize, UIImageSymbolWeight weight) {
    UIImageSymbolConfiguration *config = [UIImageSymbolConfiguration configurationWithPointSize:pointSize
                                                                                         weight:weight];
    return [UIImage systemImageNamed:name withConfiguration:config];
}

/// Standard iOS controls drawn over the page, as in any chat app: a bar at the
/// top (chat list button, the chat's title, new chat and "..." buttons) and a
/// message bar at the bottom (+, model, a text field that grows, dictation and
/// one send / stop / voice button). System colours, tint and SF Symbols only.
/// Both bars are solid and take the page's own edge colours, so they cover
/// claude.ai's header and message box. Each button asks the page to press
/// claude.ai's own control (onAction); the page reports which controls it found
/// and claude.ai's state (applyState:). Touches between the bars go through to
/// the page.
API_AVAILABLE(ios(15.0))
@interface NativeChrome : UIView <UITextViewDelegate>
@property (nonatomic, copy) void (^onAction)(NSString *name, NSString *argument);
- (void)applyState:(NSDictionary *)state;
/// After a send: clears the box when it worked and gives the keyboard back.
- (void)finishSend:(BOOL)sent;
/// The app's message box has the keyboard.
@property (nonatomic, readonly) BOOL editing;
/// The page's edge colours, and whether the page is dark (the controls then use
/// the dark system colours whatever the phone is set to).
- (void)setTopColor:(UIColor *)top bottomColor:(UIColor *)bottom dark:(BOOL)dark;
@end

@implementation NativeChrome {
    UIView *_topBar;
    UIView *_bottomBar;
    UILabel *_titleLabel;
    UIButton *_listButton;
    UIButton *_incognitoButton;
    UIButton *_newChatButton;
    UIButton *_moreButton;
    UIView *_field;
    UITextView *_textView;
    UILabel *_placeholder;
    NSLayoutConstraint *_textHeight;
    UIButton *_plusButton;
    UIButton *_modelButton;
    UIButton *_micButton;
    UIButton *_actionButton;
    NSString *_actionName;
    BOOL _shown;
    BOOL _streaming;
    BOOL _voice;
    BOOL _refocusAfterSend;
}

- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        self.translatesAutoresizingMaskIntoConstraints = NO;
        self.hidden = YES;
        self.alpha = 0;
        [self buildControls];
    }
    return self;
}

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *hit = [super hitTest:point withEvent:event];
    return hit == self ? nil : hit;
}

- (UIButton *)barButton:(NSString *)symbol action:(SEL)action label:(NSString *)label {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    button.translatesAutoresizingMaskIntoConstraints = NO;
    [button setImage:SymbolImage(symbol, 19, UIImageSymbolWeightRegular) forState:UIControlStateNormal];
    button.accessibilityLabel = label;
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    [NSLayoutConstraint activateConstraints:@[
        [button.widthAnchor constraintEqualToConstant:44],
        [button.heightAnchor constraintEqualToConstant:44],
    ]];
    return button;
}

/// A solid bar with a hairline along the edge that faces the page.
- (UIView *)barWithLineAtTop:(BOOL)lineAtTop {
    UIView *bar = [[UIView alloc] init];
    bar.translatesAutoresizingMaskIntoConstraints = NO;
    bar.backgroundColor = AppBackgroundColor();
    UIView *line = [[UIView alloc] init];
    line.translatesAutoresizingMaskIntoConstraints = NO;
    line.backgroundColor = UIColor.separatorColor;
    [bar addSubview:line];
    [NSLayoutConstraint activateConstraints:@[
        [line.leadingAnchor constraintEqualToAnchor:bar.leadingAnchor],
        [line.trailingAnchor constraintEqualToAnchor:bar.trailingAnchor],
        [line.heightAnchor constraintEqualToConstant:1.0 / MAX(UIScreen.mainScreen.scale, 1.0)],
        lineAtTop ? [line.topAnchor constraintEqualToAnchor:bar.topAnchor]
                  : [line.bottomAnchor constraintEqualToAnchor:bar.bottomAnchor],
    ]];
    [self addSubview:bar];
    return bar;
}

- (void)buildControls {
    UILayoutGuide *safe = self.safeAreaLayoutGuide;

    // The top bar.
    _topBar = [self barWithLineAtTop:NO];
    _listButton = [self barButton:@"sidebar.left" action:@selector(menuTapped) label:@"Chats"];
    _incognitoButton = [self barButton:@"eye.slash" action:@selector(incognitoTapped) label:@"Incognito chat"];
    _newChatButton = [self barButton:@"square.and.pencil" action:@selector(newChatTapped) label:@"New chat"];
    _moreButton = [self barButton:@"ellipsis.circle" action:@selector(moreTapped) label:@"Chat options"];

    UIStackView *rightButtons = [[UIStackView alloc] initWithArrangedSubviews:@[_incognitoButton, _newChatButton, _moreButton]];
    rightButtons.translatesAutoresizingMaskIntoConstraints = NO;
    rightButtons.axis = UILayoutConstraintAxisHorizontal;

    _titleLabel = [[UILabel alloc] init];
    _titleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _titleLabel.font = [UIFont systemFontOfSize:17 weight:UIFontWeightSemibold];
    _titleLabel.textColor = UIColor.labelColor;
    _titleLabel.textAlignment = NSTextAlignmentCenter;
    _titleLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    _titleLabel.text = @"New chat";
    [_titleLabel setContentCompressionResistancePriority:UILayoutPriorityDefaultLow forAxis:UILayoutConstraintAxisHorizontal];

    for (UIView *view in @[_listButton, rightButtons, _titleLabel]) {
        [_topBar addSubview:view];
    }
    [NSLayoutConstraint activateConstraints:@[
        [_topBar.topAnchor constraintEqualToAnchor:self.topAnchor],
        [_topBar.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
        [_topBar.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
        [_topBar.bottomAnchor constraintEqualToAnchor:safe.topAnchor constant:44],
        [_listButton.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:4],
        [_listButton.bottomAnchor constraintEqualToAnchor:_topBar.bottomAnchor],
        [rightButtons.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-4],
        [rightButtons.bottomAnchor constraintEqualToAnchor:_topBar.bottomAnchor],
        [_titleLabel.centerXAnchor constraintEqualToAnchor:_topBar.centerXAnchor],
        [_titleLabel.centerYAnchor constraintEqualToAnchor:_listButton.centerYAnchor],
        [_titleLabel.leadingAnchor constraintGreaterThanOrEqualToAnchor:_listButton.trailingAnchor constant:4],
        [_titleLabel.trailingAnchor constraintLessThanOrEqualToAnchor:rightButtons.leadingAnchor constant:-4],
    ]];

    // The message bar.
    _bottomBar = [self barWithLineAtTop:YES];

    UIButtonConfiguration *modelConfig = [UIButtonConfiguration plainButtonConfiguration];
    modelConfig.contentInsets = NSDirectionalEdgeInsetsMake(0, 8, 0, 8);
    modelConfig.image = SymbolImage(@"chevron.down", 10, UIImageSymbolWeightSemibold);
    modelConfig.imagePlacement = NSDirectionalRectEdgeTrailing;
    modelConfig.imagePadding = 4;
    modelConfig.baseForegroundColor = UIColor.secondaryLabelColor;
    _modelButton = [UIButton buttonWithConfiguration:modelConfig primaryAction:nil];
    _modelButton.translatesAutoresizingMaskIntoConstraints = NO;
    _modelButton.accessibilityLabel = @"Model";
    [_modelButton addTarget:self action:@selector(modelTapped) forControlEvents:UIControlEventTouchUpInside];
    [self setModel:@"" effort:@""];

    _plusButton = [self barButton:@"plus" action:@selector(plusTapped) label:@"Add files"];

    _field = [[UIView alloc] init];
    _field.translatesAutoresizingMaskIntoConstraints = NO;
    _field.backgroundColor = UIColor.tertiarySystemFillColor;
    _field.layer.cornerRadius = 18;

    _textView = [[UITextView alloc] init];
    _textView.translatesAutoresizingMaskIntoConstraints = NO;
    _textView.font = [UIFont systemFontOfSize:17];
    _textView.textColor = UIColor.labelColor;
    _textView.backgroundColor = UIColor.clearColor;
    _textView.textContainerInset = UIEdgeInsetsMake(8, 0, 8, 0);
    _textView.scrollEnabled = NO;
    _textView.delegate = self;

    _placeholder = [[UILabel alloc] init];
    _placeholder.translatesAutoresizingMaskIntoConstraints = NO;
    _placeholder.font = [UIFont systemFontOfSize:17];
    _placeholder.textColor = UIColor.placeholderTextColor;
    _placeholder.text = @"Message";
    _placeholder.userInteractionEnabled = NO;

    _micButton = [self barButton:@"mic" action:@selector(micTapped) label:@"Dictate"];
    _micButton.tintColor = UIColor.secondaryLabelColor;

    _actionButton = [UIButton buttonWithType:UIButtonTypeSystem];
    _actionButton.translatesAutoresizingMaskIntoConstraints = NO;
    _actionButton.layer.cornerRadius = 16;
    [_actionButton addTarget:self action:@selector(actionTapped) forControlEvents:UIControlEventTouchUpInside];

    for (UIView *view in @[_textView, _placeholder, _micButton]) {
        [_field addSubview:view];
    }
    for (UIView *view in @[_modelButton, _plusButton, _field, _actionButton]) {
        [_bottomBar addSubview:view];
    }

    _textHeight = [_textView.heightAnchor constraintEqualToConstant:36];
    [NSLayoutConstraint activateConstraints:@[
        [_bottomBar.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
        [_bottomBar.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
        [_bottomBar.bottomAnchor constraintEqualToAnchor:self.bottomAnchor],
        [_bottomBar.topAnchor constraintEqualToAnchor:_modelButton.topAnchor constant:-4],

        [_modelButton.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:8],
        [_modelButton.heightAnchor constraintEqualToConstant:30],
        [_modelButton.trailingAnchor constraintLessThanOrEqualToAnchor:safe.trailingAnchor constant:-8],
        [_modelButton.bottomAnchor constraintEqualToAnchor:_field.topAnchor constant:-2],

        [_plusButton.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:4],
        [_plusButton.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor constant:4],

        [_field.leadingAnchor constraintEqualToAnchor:_plusButton.trailingAnchor constant:2],
        [_field.trailingAnchor constraintEqualToAnchor:_actionButton.leadingAnchor constant:-8],
        [_field.bottomAnchor constraintEqualToAnchor:self.keyboardLayoutGuide.topAnchor constant:-8],

        [_textView.topAnchor constraintEqualToAnchor:_field.topAnchor],
        [_textView.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor],
        [_textView.leadingAnchor constraintEqualToAnchor:_field.leadingAnchor constant:8],
        [_textView.trailingAnchor constraintEqualToAnchor:_micButton.leadingAnchor],
        _textHeight,
        [_placeholder.leadingAnchor constraintEqualToAnchor:_textView.leadingAnchor constant:5],
        [_placeholder.centerYAnchor constraintEqualToAnchor:_textView.topAnchor constant:18],
        [_micButton.trailingAnchor constraintEqualToAnchor:_field.trailingAnchor],
        [_micButton.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor constant:4],

        [_actionButton.widthAnchor constraintEqualToConstant:32],
        [_actionButton.heightAnchor constraintEqualToConstant:32],
        [_actionButton.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
        [_actionButton.bottomAnchor constraintEqualToAnchor:_field.bottomAnchor constant:-2],
    ]];
    [self updateActionButton];
}

- (void)setTopColor:(UIColor *)top bottomColor:(UIColor *)bottom dark:(BOOL)dark {
    _topBar.backgroundColor = top;
    _bottomBar.backgroundColor = bottom;
    self.overrideUserInterfaceStyle = dark ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;
}

- (void)setModel:(NSString *)model effort:(NSString *)effort {
    UIFont *font = [UIFont systemFontOfSize:15];
    NSMutableAttributedString *title = [[NSMutableAttributedString alloc] initWithString:model.length ? model : @"Model"
        attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: UIColor.secondaryLabelColor}];
    if (effort.length) {
        [title appendAttributedString:[[NSAttributedString alloc] initWithString:[@" " stringByAppendingString:effort]
            attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: UIColor.tertiaryLabelColor}]];
    }
    UIButtonConfiguration *config = _modelButton.configuration;
    config.attributedTitle = title;
    _modelButton.configuration = config;
}

- (NSString *)trimmedText {
    return [_textView.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

/// One button at the right of the message bar: stop while Claude answers, send
/// when there is text, voice mode otherwise.
- (void)updateActionButton {
    BOOL hasText = [self trimmedText].length > 0;
    UIImage *image;
    UIColor *background;
    UIColor *tint;
    NSString *label;
    if (_streaming) {
        _actionName = @"stop";
        image = SymbolImage(@"stop.fill", 13, UIImageSymbolWeightRegular);
        background = UIColor.labelColor;
        tint = UIColor.systemBackgroundColor;
        label = @"Stop";
    } else if (hasText || !_voice) {
        _actionName = @"send";
        image = SymbolImage(@"arrow.up", 15, UIImageSymbolWeightBold);
        background = hasText ? UIColor.tintColor : UIColor.tertiarySystemFillColor;
        tint = hasText ? UIColor.whiteColor : UIColor.tertiaryLabelColor;
        label = @"Send";
    } else {
        _actionName = @"voice";
        image = SymbolImage(@"waveform", 19, UIImageSymbolWeightRegular);
        background = UIColor.clearColor;
        tint = UIColor.tintColor;
        label = @"Voice mode";
    }
    [_actionButton setImage:image forState:UIControlStateNormal];
    _actionButton.backgroundColor = background;
    _actionButton.tintColor = tint;
    _actionButton.accessibilityLabel = label;
    _micButton.hidden = _streaming;
}

- (void)textViewDidChange:(UITextView *)textView {
    _placeholder.hidden = textView.text.length > 0;
    CGFloat width = textView.bounds.size.width > 0 ? textView.bounds.size.width : 260;
    CGFloat needed = [textView sizeThatFits:CGSizeMake(width, CGFLOAT_MAX)].height;
    _textHeight.constant = MIN(MAX(needed, 36), 140);
    textView.scrollEnabled = needed > 140;
    [self updateActionButton];
}

- (void)applyState:(NSDictionary *)state {
    BOOL ready = [state[@"ready"] boolValue];
    BOOL sidebarOpen = [state[@"sidebarOpen"] boolValue];
    NSString *page = [state[@"page"] isKindOfClass:NSString.class] ? state[@"page"] : @"";
    BOOL inChat = [page isEqualToString:@"chat"];
    _streaming = [state[@"streaming"] boolValue];
    _voice = [state[@"voice"] boolValue];

    NSString *title = [state[@"title"] isKindOfClass:NSString.class] ? state[@"title"] : @"";
    _titleLabel.text = title.length ? title : (inChat ? @"Chat" : @"New chat");
    _incognitoButton.hidden = inChat || ![state[@"incognito"] boolValue];
    _newChatButton.hidden = !inChat;
    _moreButton.hidden = !inChat;
    _moreButton.enabled = [state[@"more"] boolValue];
    _micButton.enabled = [state[@"dictate"] boolValue];
    NSString *model = [state[@"model"] isKindOfClass:NSString.class] ? state[@"model"] : @"";
    NSString *effort = [state[@"effort"] isKindOfClass:NSString.class] ? state[@"effort"] : @"";
    [self setModel:model effort:effort];
    [self updateActionButton];

    BOOL show = ready && !sidebarOpen;
    if (show == _shown) {
        return;
    }
    _shown = show;
    if (!show && _textView.isFirstResponder) {
        [_textView resignFirstResponder];
    }
    if (show) {
        self.hidden = NO;
    }
    [UIView animateWithDuration:0.2 animations:^{
        self.alpha = show ? 1 : 0;
    } completion:^(BOOL finished) {
        if (!self->_shown) {
            self.hidden = YES;
        }
    }];
}

- (BOOL)editing {
    return _textView.isFirstResponder;
}

- (void)finishSend:(BOOL)sent {
    if (sent) {
        _textView.text = @"";
        [self textViewDidChange:_textView];
    }
    if (_refocusAfterSend) {
        [_textView becomeFirstResponder];
    }
    _refocusAfterSend = NO;
}

- (void)fire:(NSString *)name argument:(NSString *)argument {
    if (self.onAction) {
        self.onAction(name, argument);
    }
}

- (void)menuTapped {
    [_textView resignFirstResponder];
    [self fire:@"sidebar" argument:nil];
}
- (void)incognitoTapped { [self fire:@"incognito" argument:nil]; }
- (void)newChatTapped { [self fire:@"newChat" argument:nil]; }
- (void)moreTapped {
    [_textView resignFirstResponder];
    [self fire:@"more" argument:nil];
}
- (void)plusTapped {
    [_textView resignFirstResponder];
    [self fire:@"plus" argument:nil];
}
- (void)modelTapped {
    [_textView resignFirstResponder];
    [self fire:@"model" argument:nil];
}
- (void)micTapped { [self fire:@"dictate" argument:nil]; }
- (void)actionTapped {
    if ([_actionName isEqualToString:@"send"]) {
        NSString *text = [self trimmedText];
        if (text.length == 0) {
            return;
        }
        _refocusAfterSend = _textView.isFirstResponder;
        [self fire:@"send" argument:text];
    } else {
        [_textView resignFirstResponder];
        [self fire:_actionName argument:nil];
    }
}

@end

@interface ViewController () <WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate, UIGestureRecognizerDelegate, WKHTTPCookieStoreObserver>

@property (nonatomic) IBOutlet WKWebView *webView;

/// Status bar text colour, set from the page's own background (see -handleAppearance:).
@property (nonatomic, assign) UIStatusBarStyle pageStatusBarStyle;

/// Plain views behind the status bar and the home indicator, painted in the
/// colours the page draws at its top and bottom edges.
@property (nonatomic, strong) UIView *topFill;
@property (nonatomic, strong) UIView *bottomFill;

@property (nonatomic, strong) LoadingOverlayView *loadingOverlay;
@property (nonatomic, strong) NSTimer *settleTimer;
@property (nonatomic, strong) NSDate *lastActivity;
@property (nonatomic, strong) NSDate *loadingStartedAt;
@property (nonatomic, assign) NSInteger modulesDone;
@property (nonatomic, assign) NSInteger modulesExpected;
@property (nonatomic, assign) NSInteger pendingScripts;
@property (nonatomic, assign) BOOL pageReady;
@property (nonatomic, assign) BOOL navigationFinished;
@property (nonatomic, copy, nullable) NSString *lastErrorMessage;
@property (nonatomic, copy, nullable) NSString *moduleFailure;
@property (nonatomic, assign) NSInteger errorCount;
@property (nonatomic, copy, nullable) NSString *siteBuild;
@property (nonatomic, assign) BOOL showingFailure;

/// Times the page process was stopped recently, to avoid reloading in a loop.
@property (nonatomic, strong) NSMutableArray<NSDate *> *terminations;
/// The page process was stopped while the app was in the background.
@property (nonatomic, assign) BOOL reloadWhenActive;
/// The failure screen is up because the page process is gone.
@property (nonatomic, assign) BOOL failureNeedsReload;
@property (nonatomic, assign) BOOL startedLoading;
@property (nonatomic, strong) NSTimer *cookieSaveTimer;
@property (nonatomic, copy, nullable) NSString *sessionFingerprint;
@property (nonatomic, assign) BOOL observingCookies;
/// Pasteboard contents already offered as a sign-in link.
@property (nonatomic, assign) NSInteger offeredPasteboardChange;
/// The native top buttons and message box (NativeChrome, iOS 15 and later).
@property (nonatomic, strong, nullable) UIView *nativeChrome;

@end

@implementation ViewController

/// Injects a bundled .js file as a document-start user script, in the order added.
- (void)injectScriptNamed:(NSString *)name {
    NSURL *scriptURL = [NSBundle.mainBundle URLForResource:name withExtension:@"js"];
    NSString *js = scriptURL
        ? [NSString stringWithContentsOfURL:scriptURL encoding:NSUTF8StringEncoding error:nil]
        : nil;
    if (js.length == 0) {
        NSLog(@"[inject] %@.js is missing from the bundle", name);
        return;
    }

    WKUserScript *userScript = [[WKUserScript alloc] initWithSource:js
                                                     injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                  forMainFrameOnly:YES];
    [_webView.configuration.userContentController addUserScript:userScript];
}

- (void)injectIOSVersion {
    NSOperatingSystemVersion version = [[NSProcessInfo processInfo] operatingSystemVersion];
    NSString *versionString = [NSString stringWithFormat:@"%ld.%ld",
                               (long)version.majorVersion,
                               (long)version.minorVersion];
    
    NSString *js = [NSString stringWithFormat:
                    @"window.iosVersion = %@;",
                    [self jsStringLiteral:versionString]];
    
    WKUserScript *script = [[WKUserScript alloc] initWithSource:js
                                                  injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                               forMainFrameOnly:YES];
    [_webView.configuration.userContentController addUserScript:script];
}

- (void)injectCustomCSS {
    NSString *css = @"button[data-testid='login-with-google'] { display: none !important; }"
    "button[data-testid='login-with-google'] + p { display: none !important; }"
    ".dframe-root[data-variant='web'][data-collapsed][data-hovering]:not([data-wco]) .dframe-sidebar-body { opacity: 1 !important; }";
    NSString *js = [NSString stringWithFormat:
                    @"(function(){"
                    "var s=document.createElement('style');"
                    "s.textContent=%@;"
                    "document.head.appendChild(s);"
                    "})()", [self jsStringLiteral:css]];
    WKUserScript *script = [[WKUserScript alloc] initWithSource:js
                                                  injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                                               forMainFrameOnly:YES];
    [_webView.configuration.userContentController addUserScript:script];
}

- (NSString *)jsStringLiteral:(NSString *)str {
    NSString *escaped = [str stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@"'" withString:@"\\'"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
    return [NSString stringWithFormat:@"'%@'", escaped];
}

- (void)viewDidLoad {
    [super viewDidLoad];

    self.view.backgroundColor = AppBackgroundColor();
    self.pageStatusBarStyle = UIStatusBarStyleDefault;

    // The page stays inside the safe area (claude.ai's mobile web layout does not
    // pad itself for the status bar), and the strips above and below it are
    // painted in the page's own edge colours so the screen reads as one surface.
    [self installEdgeFills];
    [self applyEdgeReport:[[NSUserDefaults standardUserDefaults] objectForKey:kEdgeColoursKey] animated:NO];

    // No pull-to-refresh and no rubber-banding of the whole page (the chat list
    // still scrolls and bounces inside it). Reload lives in the three-finger menu.
    _webView.scrollView.bounces = NO;
    _webView.scrollView.alwaysBounceVertical = NO;
    _webView.scrollView.alwaysBounceHorizontal = NO;

    // No page previews: long-pressing a link shows the plain menu instead
    // (Open, Copy, Share), and message text can be selected and copied.
    _webView.allowsLinkPreview = NO;

    _webView.opaque = NO;
    _webView.backgroundColor = UIColor.clearColor;
    _webView.scrollView.backgroundColor = UIColor.clearColor;
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    _webView.scrollView.scrollEnabled = YES;

    [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"patchScript"];
    [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"loadingStatus"];
    [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"appearance"];
    [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"appEvent"];
    [self.webView.configuration.userContentController addScriptMessageHandler:self name:@"chrome"];
    [self installNativeChrome];
    // Again now that the native bars exist: they take the same colours.
    [self applyEdgeReport:[[NSUserDefaults standardUserDefaults] objectForKey:kEdgeColoursKey] animated:NO];
    if (@available(iOS 14.0, *)) {
        [self.webView.configuration.userContentController addScriptMessageHandlerWithReply:[[ModuleStore alloc] init]
                                                                              contentWorld:WKContentWorld.pageWorld
                                                                                      name:@"moduleStore"];
    }

    [self.webView addObserver:self forKeyPath:@"estimatedProgress" options:0 context:NULL];

    // Three-finger long press opens the app menu: Reload, Open copied link, Page
    // size, Advanced, Copy debug log.
    UILongPressGestureRecognizer *menuGesture =
        [[UILongPressGestureRecognizer alloc] initWithTarget:self action:@selector(handleMenuGesture:)];
    menuGesture.numberOfTouchesRequired = 3;
    menuGesture.minimumPressDuration = 0.6;
    menuGesture.cancelsTouchesInView = NO;
    menuGesture.delegate = self;
    [_webView addGestureRecognizer:menuGesture];

    // Voice replies must not end up on the quiet earpiece speaker.
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(audioRouteChanged:)
                                                 name:AVAudioSessionRouteChangeNotification
                                               object:nil];
    // The page gets room at the end of its message list for the app's keyboard.
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(keyboardWillChangeFrame:)
                                                 name:UIKeyboardWillChangeFrameNotification
                                               object:nil];

    // Going to the background and back: logged, cookies saved, and a page that
    // iOS stopped in the meantime is reloaded.
    NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
    [center addObserver:self selector:@selector(sceneDidEnterBackground:)
                   name:UISceneDidEnterBackgroundNotification object:nil];
    [center addObserver:self selector:@selector(sceneWillEnterForeground:)
                   name:UISceneWillEnterForegroundNotification object:nil];
    [center addObserver:self selector:@selector(sceneDidActivate:)
                   name:UISceneDidActivateNotification object:nil];

    self.terminations = [NSMutableArray array];
    [self logEvent:[NSString stringWithFormat:@"app started (fast loading %@, page size %ld%%, tap fix %@, diagnostics %@)",
                    SettingBool(kFastLoadKey, YES) ? @"on" : @"off",
                    (long)lround(PageScaleSetting() * 100),
                    SettingBool(kTapFixKey, YES) ? @"on" : @"off",
                    SettingBool(kDiagnosticsKey, NO) ? @"on" : @"off"]];

    //[self showLoadingOverlay];

    // Injecting the polyfills reads a few hundred files off disk, so give the
    // overlay a chance to reach the screen before blocking the main thread.
    dispatch_async(dispatch_get_main_queue(), ^{
        [self startLoading];
    });
}

- (void)dealloc {
    [_settleTimer invalidate];
    [_cookieSaveTimer invalidate];
    if (_observingCookies) {
        [_webView.configuration.websiteDataStore.httpCookieStore removeObserver:self];
    }
    [_webView removeObserver:self forKeyPath:@"estimatedProgress"];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

/// The web view keeps the storyboard's safe-area constraints. These two views
/// cover what is left: the status-bar strip and the home-indicator strip.
- (void)installEdgeFills {
    UIView *top = [[UIView alloc] init];
    UIView *bottom = [[UIView alloc] init];
    for (UIView *fill in @[top, bottom]) {
        fill.translatesAutoresizingMaskIntoConstraints = NO;
        fill.backgroundColor = AppBackgroundColor();
        fill.userInteractionEnabled = NO;
        [self.view addSubview:fill];
    }

    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [top.topAnchor constraintEqualToAnchor:self.view.topAnchor],
        [top.bottomAnchor constraintEqualToAnchor:safe.topAnchor],
        [top.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [top.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [bottom.topAnchor constraintEqualToAnchor:safe.bottomAnchor],
        [bottom.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [bottom.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [bottom.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    ]];

    self.topFill = top;
    self.bottomFill = bottom;
}

#pragma mark - Native controls

/// Adds the native top buttons and message box over the page (iOS 15 and later:
/// they follow the keyboard with keyboardLayoutGuide). They stay hidden until the
/// page reports that it found claude.ai's own controls and hid them.
- (void)installNativeChrome {
    if (@available(iOS 15.0, *)) {
        NativeChrome *chrome = [[NativeChrome alloc] initWithFrame:CGRectZero];
        __weak typeof(self) weakSelf = self;
        chrome.onAction = ^(NSString *name, NSString *argument) {
            [weakSelf runChromeAction:name argument:argument];
        };
        [self.view insertSubview:chrome aboveSubview:self.webView];
        [NSLayoutConstraint activateConstraints:@[
            [chrome.topAnchor constraintEqualToAnchor:self.view.topAnchor],
            [chrome.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
            [chrome.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
            [chrome.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        ]];
        self.nativeChrome = chrome;
    }
}

/// Asks the page to press one of claude.ai's controls (app-tweaks.js,
/// window.__appChrome.run); "send" also types the text into claude.ai's box.
- (void)runChromeAction:(NSString *)name argument:(NSString *)argument {
    if (@available(iOS 15.0, *)) {
        __weak typeof(self) weakSelf = self;
        [self.webView callAsyncJavaScript:@"return window.__appChrome ? await window.__appChrome.run(name, arg) : 'page not ready';"
                                arguments:@{@"name": name, @"arg": argument ?: @""}
                                  inFrame:nil
                           inContentWorld:WKContentWorld.pageWorld
                        completionHandler:^(id result, NSError *error) {
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf) {
                return;
            }
            NSString *outcome = [result isKindOfClass:NSString.class] ? result : (error.localizedDescription ?: @"no answer");
            if (![name isEqualToString:@"send"]) {
                return;
            }
            BOOL sent = [outcome isEqualToString:@"ok"];
            [(NativeChrome *)strongSelf.nativeChrome finishSend:sent];
            if (!sent) {
                [strongSelf logEvent:[@"native send failed: " stringByAppendingString:outcome]];
                UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Message not sent"
                                                                               message:[NSString stringWithFormat:@"%@. Your text is still in the box. If this keeps happening, turn off Native controls in Advanced.", outcome]
                                                                        preferredStyle:UIAlertControllerStyleAlert];
                [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
                [[strongSelf topPresenter] presentViewController:alert animated:YES completion:nil];
            }
        }];
    }
}

/// The page does not shrink for the app's keyboard, so it is told how much of it
/// the keyboard covers (points, with the page's width in points to convert).
- (void)keyboardWillChangeFrame:(NSNotification *)note {
    if (@available(iOS 15.0, *)) {
        NativeChrome *chrome = (NativeChrome *)self.nativeChrome;
        if (chrome == nil || chrome.hidden) {
            return;
        }
        CGRect keyboard = [note.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
        CGRect page = [self.webView convertRect:self.webView.bounds toView:nil];
        CGFloat covered = chrome.editing ? MAX(0, CGRectGetMaxY(page) - CGRectGetMinY(keyboard)) : 0;
        NSString *argument = [NSString stringWithFormat:@"%.0f,%.0f", covered, CGRectGetWidth(page)];
        [self runChromeAction:@"keyboard" argument:argument];
    }
}

- (void)handleChromeState:(id)body {
    if (![body isKindOfClass:NSDictionary.class]) {
        return;
    }
    if (@available(iOS 15.0, *)) {
        [(NativeChrome *)self.nativeChrome applyState:body];
    }
}

/// Everything injected into the page, in this order (see CLAUDE.md).
- (void)installUserScripts {
    [self injectSettings];
    [self injectScriptNamed:@"app-tweaks"];
    [self injectIOSVersion];
    [self injectCustomCSS];
    [self injectScriptNamed:@"legacy-transpiler"];
    [self injectWorkerSource];
    [self injectScriptNamed:@"patch"];
    [PolyfillsLoader injectPolyfillsIntoController:_webView.configuration.userContentController];
}

- (void)startLoading {
    [self.loadingOverlay setStage:@"Preparing compatibility layer" detail:nil];

    [self installUserScripts];

    [self.loadingOverlay setProgress:0.05 animated:YES];
    [self.loadingOverlay setStage:@"Connecting to claude.ai" detail:nil];

    // Put back any sign-in cookie iOS lost when the app was closed, then load.
    __weak typeof(self) weakSelf = self;
    [self restoreSessionCookiesThen:^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }
        strongSelf.startedLoading = YES;
        [strongSelf.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"https://claude.ai"]]];
        // Started from a link: offer it once the app is on screen.
        [strongSelf presentQueuedURLIfAny];
//        [_webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"http://192.168.1.136:3000"]]];
    }];
    [self clearLeftoverWebCachesIfLarge];
}

/// claude.ai keeps no web caches (CacheStorage) of its own, and since round 7 the
/// app keeps its modules in its own files, yet 2 GB of old web-cache files were
/// still on disk (5 Nov 2026): the old caches were deleted while WebKit's
/// networking process kept crashing, and their files were never cleaned up. They
/// count against claude.ai's storage quota, which left IndexedDB without space.
/// When that folder holds more than 100 MB, WebKit is asked to remove its web-cache
/// data, and only that: cookies, IndexedDB and local storage stay.
- (void)clearLeftoverWebCachesIfLarge {
    NSURL *caches = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                          inDomains:NSUserDomainMask] firstObject];
    NSURL *folder = [caches URLByAppendingPathComponent:@"WebKit/CacheStorage" isDirectory:YES];
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        long long bytes = [weakSelf sizeOfFolder:folder];
        if (bytes < 100LL * 1024 * 1024) {
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf) {
                return;
            }
            NSDate *started = [NSDate date];
            [strongSelf.webView.configuration.websiteDataStore removeDataOfTypes:[NSSet setWithObject:WKWebsiteDataTypeFetchCache]
                                                                   modifiedSince:[NSDate distantPast]
                                                               completionHandler:^{
                NSTimeInterval seconds = -[started timeIntervalSinceNow];
                dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    long long left = [weakSelf sizeOfFolder:folder];
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [weakSelf logEvent:[NSString stringWithFormat:@"web cache storage cleared: %.0f MB before, %.0f MB left, took %.1f s",
                                            bytes / 1048576.0, left / 1048576.0, seconds]];
                    });
                });
            }];
        });
    });
}

/// Adds a script that runs before anything on the page (in the order added).
- (void)addDocumentStartScript:(NSString *)js {
    WKUserScript *script = [[WKUserScript alloc] initWithSource:js
                                                  injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                               forMainFrameOnly:YES];
    [_webView.configuration.userContentController addUserScript:script];
}

- (NSString *)bundledScript:(NSString *)name {
    NSURL *url = [NSBundle.mainBundle URLForResource:name withExtension:@"js"];
    return url ? [NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:nil] : nil;
}

/// Menu settings, read by app-tweaks.js and patch.js as window.__appSettings.
- (void)injectSettings {
    NSDictionary *settings = @{
        @"fastLoad": @(SettingBool(kFastLoadKey, YES)),
        @"tapFix": @(SettingBool(kTapFixKey, YES)),
        @"pageScale": @(PageScaleSetting()),
        @"diagnostics": @(SettingBool(kDiagnosticsKey, NO)),
        // A BOOL, so it reaches the page as true/false (an int would arrive as 1).
        @"nativeChrome": @((BOOL)(self.nativeChrome != nil && SettingBool(kNativeChromeKey, YES))),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:settings options:0 error:nil];
    if (json == nil) {
        return;
    }
    NSString *object = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    [self addDocumentStartScript:[NSString stringWithFormat:@"window.__appSettings = %@;", object]];
}

/// Fast loading transpiles in background workers. A worker cannot see the page's
/// scripts, so it gets its own copy of the transpiler (plus transpile-worker.js)
/// as text, which patch.js turns into the worker.
- (void)injectWorkerSource {
    if (!SettingBool(kFastLoadKey, YES)) {
        return;
    }
    NSString *transpiler = [self bundledScript:@"legacy-transpiler"];
    NSString *glue = [self bundledScript:@"transpile-worker"];
    if (transpiler.length == 0 || glue.length == 0) {
        return;
    }
    NSString *source = [NSString stringWithFormat:@"%@\n;\n%@", transpiler, glue];
    NSData *json = [NSJSONSerialization dataWithJSONObject:@[source] options:0 error:nil];
    if (json == nil) {
        return;
    }
    NSString *array = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    [self addDocumentStartScript:[NSString stringWithFormat:@"window.__appWorkerSource = %@[0];", array]];
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    return self.pageStatusBarStyle;
}

#pragma mark - App feel

/// Reads one {r, g, b} colour (0-255) sent by app-tweaks.js.
- (UIColor *)colorFromReport:(id)value {
    if (![value isKindOfClass:NSDictionary.class]) {
        return nil;
    }
    NSDictionary *components = value;
    NSNumber *r = components[@"r"];
    NSNumber *g = components[@"g"];
    NSNumber *b = components[@"b"];
    if (![r isKindOfClass:NSNumber.class] || ![g isKindOfClass:NSNumber.class] || ![b isKindOfClass:NSNumber.class]) {
        return nil;
    }
    return [UIColor colorWithRed:MIN(MAX(r.doubleValue / 255.0, 0.0), 1.0)
                           green:MIN(MAX(g.doubleValue / 255.0, 0.0), 1.0)
                            blue:MIN(MAX(b.doubleValue / 255.0, 0.0), 1.0)
                           alpha:1.0];
}

/// The page reports the colours it draws along its top and bottom edges
/// (app-tweaks.js). The strips outside the safe area take those colours, and the
/// status bar text follows the top one, so it stays readable whichever theme
/// Claude is set to. The last report is remembered and applied at the next
/// launch, so the app opens in Claude's colours instead of flashing the
/// phone-theme default while the page loads.
- (void)handleAppearance:(id)body {
    if ([self applyEdgeReport:body animated:YES]) {
        [[NSUserDefaults standardUserDefaults] setObject:body forKey:kEdgeColoursKey];
    }
}

- (BOOL)applyEdgeReport:(id)body animated:(BOOL)animated {
    if (![body isKindOfClass:NSDictionary.class]) {
        return NO;
    }
    NSDictionary *report = body;
    UIColor *top = [self colorFromReport:report[@"top"]];
    if (top == nil) {
        return NO;
    }
    UIColor *bottom = [self colorFromReport:report[@"bottom"]] ?: top;

    CGFloat red = 0, green = 0, blue = 0, alpha = 0;
    [top getRed:&red green:&green blue:&blue alpha:&alpha];
    CGFloat luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    UIStatusBarStyle style = luminance < 0.5 ? UIStatusBarStyleLightContent : UIStatusBarStyleDarkContent;

    void (^apply)(void) = ^{
        self.topFill.backgroundColor = top;
        self.bottomFill.backgroundColor = bottom;
        self.view.backgroundColor = top;
        if (@available(iOS 15.0, *)) {
            [(NativeChrome *)self.nativeChrome setTopColor:top
                                               bottomColor:bottom
                                                      dark:style == UIStatusBarStyleLightContent];
        }
        if (style != self.pageStatusBarStyle) {
            self.pageStatusBarStyle = style;
            [self setNeedsStatusBarAppearanceUpdate];
        }
    };

    if (animated) {
        // A short cross-fade, picking up from wherever a running fade has got
        // to, so the strips follow the sidebar instead of jumping.
        [UIView animateWithDuration:0.18
                              delay:0
                            options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
                         animations:apply
                         completion:nil];
    } else {
        apply();
    }
    return YES;
}

- (BOOL)isClaudeHost:(NSString *)host {
    NSString *lower = host.lowercaseString;
    return [lower isEqualToString:@"claude.ai"] || [lower hasSuffix:@".claude.ai"];
}

- (BOOL)isWebURL:(NSURL *)url {
    NSString *scheme = url.scheme.lowercaseString;
    return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
}

- (BOOL)isAppHandoffURL:(NSURL *)url {
    NSString *scheme = url.scheme.lowercaseString;
    return [scheme isEqualToString:@"mailto"] || [scheme isEqualToString:@"tel"] || [scheme isEqualToString:@"sms"];
}

- (UIViewController *)topPresenter {
    UIViewController *presenter = self;
    while (presenter.presentedViewController != nil) {
        presenter = presenter.presentedViewController;
    }
    return presenter;
}

/// Links that leave claude.ai open in an in-app Safari sheet, like the native app.
- (void)openExternalURL:(NSURL *)url {
    if (url == nil) {
        return;
    }
    if ([self isWebURL:url]) {
        SFSafariViewController *safari = [[SFSafariViewController alloc] initWithURL:url];
        [[self topPresenter] presentViewController:safari animated:YES completion:nil];
    } else if ([self isAppHandoffURL:url]) {
        [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
    }
}

#pragma mark - Three-finger menu

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer {
    return YES;
}

- (void)handleMenuGesture:(UILongPressGestureRecognizer *)gesture {
    if (gesture.state != UIGestureRecognizerStateBegan || self.presentedViewController != nil) {
        return;
    }

    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:nil
                                                                   message:nil
                                                            preferredStyle:UIAlertControllerStyleActionSheet];
    __weak typeof(self) weakSelf = self;
    [sheet addAction:[UIAlertAction actionWithTitle:@"Reload"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [weakSelf.webView reload];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Open copied link"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [weakSelf openCopiedLink];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"Page size: %ld%%",
                                                     (long)lround(PageScaleSetting() * 100)]
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [weakSelf showPageSizeMenu];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Advanced"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [weakSelf showAdvancedMenu];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Copy debug log"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [weakSelf copyDebugLog];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    [self presentSheet:sheet];
}

- (void)presentSheet:(UIAlertController *)sheet {
    // iPad presents action sheets as popovers, which need an anchor.
    sheet.popoverPresentationController.sourceView = self.view;
    sheet.popoverPresentationController.sourceRect =
        CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1);
    [[self topPresenter] presentViewController:sheet animated:YES completion:nil];
}

/// Settings that change what is injected into the page apply on the next load.
- (void)applySettingAndReload {
    [self.webView.configuration.userContentController removeAllUserScripts];
    [self installUserScripts];
    [self.webView reload];
}

- (void)showPageSizeMenu {
    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:@"Page size"
                                                                   message:@"Makes buttons, text and spacing bigger, keeping Claude's own layout."
                                                            preferredStyle:UIAlertControllerStyleActionSheet];
    __weak typeof(self) weakSelf = self;
    double current = PageScaleSetting();
    for (NSNumber *option in @[@1.0, @1.1, @1.18]) {
        NSString *title = [NSString stringWithFormat:@"%ld%%%@", (long)lround(option.doubleValue * 100),
                           fabs(option.doubleValue - current) < 0.001 ? @"  ✓" : @""];
        [sheet addAction:[UIAlertAction actionWithTitle:title
                                                  style:UIAlertActionStyleDefault
                                                handler:^(UIAlertAction *action) {
            [NSUserDefaults.standardUserDefaults setObject:option forKey:kPageScaleKey];
            [weakSelf logEvent:[NSString stringWithFormat:@"page size set to %ld%%", (long)lround(option.doubleValue * 100)]];
            [weakSelf applySettingAndReload];
        }]];
    }
    [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    [self presentSheet:sheet];
}

- (void)showAdvancedMenu {
    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:@"Advanced"
                                                                   message:@"For testing. Each change reloads the page."
                                                            preferredStyle:UIAlertControllerStyleActionSheet];
    __weak typeof(self) weakSelf = self;
    BOOL fast = SettingBool(kFastLoadKey, YES);
    BOOL tapFix = SettingBool(kTapFixKey, YES);
    BOOL nativeControls = SettingBool(kNativeChromeKey, YES);
    if (self.nativeChrome != nil) {
        [sheet addAction:[UIAlertAction actionWithTitle:nativeControls ? @"Native controls: on (turn off)" : @"Native controls: off (turn on)"
                                                  style:UIAlertActionStyleDefault
                                                handler:^(UIAlertAction *action) {
            [NSUserDefaults.standardUserDefaults setBool:!nativeControls forKey:kNativeChromeKey];
            [weakSelf logEvent:[NSString stringWithFormat:@"native controls turned %@", nativeControls ? @"off" : @"on"]];
            if (@available(iOS 15.0, *)) {
                [(NativeChrome *)weakSelf.nativeChrome applyState:@{@"ready": @NO}];
            }
            [weakSelf applySettingAndReload];
        }]];
    }
    [sheet addAction:[UIAlertAction actionWithTitle:fast ? @"Fast loading: on (turn off)" : @"Fast loading: off (turn on)"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [NSUserDefaults.standardUserDefaults setBool:!fast forKey:kFastLoadKey];
        [weakSelf logEvent:[NSString stringWithFormat:@"fast loading turned %@", fast ? @"off" : @"on"]];
        [weakSelf applySettingAndReload];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:tapFix ? @"Tap fix: on (turn off)" : @"Tap fix: off (turn on)"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [NSUserDefaults.standardUserDefaults setBool:!tapFix forKey:kTapFixKey];
        [weakSelf logEvent:[NSString stringWithFormat:@"tap fix turned %@", tapFix ? @"off" : @"on"]];
        [weakSelf applySettingAndReload];
    }]];
    BOOL diagnostics = SettingBool(kDiagnosticsKey, NO);
    [sheet addAction:[UIAlertAction actionWithTitle:diagnostics ? @"Diagnostics: on (turn off)" : @"Diagnostics: off (turn on)"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [NSUserDefaults.standardUserDefaults setBool:!diagnostics forKey:kDiagnosticsKey];
        [weakSelf logEvent:[NSString stringWithFormat:@"diagnostics turned %@", diagnostics ? @"off" : @"on"]];
        [weakSelf applySettingAndReload];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Clear event log"
                                              style:UIAlertActionStyleDestructive
                                            handler:^(UIAlertAction *action) {
        [NSUserDefaults.standardUserDefaults removeObjectForKey:kEventLogKey];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    [self presentSheet:sheet];
}

- (NSString *)nativeDebugSummary {
    NSOperatingSystemVersion os = [[NSProcessInfo processInfo] operatingSystemVersion];
    NSString *appVersion = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
    NSString *micPermission = @"not asked yet";
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
        case AVAuthorizationStatusAuthorized: micPermission = @"granted"; break;
        case AVAuthorizationStatusDenied: micPermission = @"denied"; break;
        case AVAuthorizationStatusRestricted: micPermission = @"restricted"; break;
        default: break;
    }

    WKHTTPCookieStore *store = self.webView.configuration.websiteDataStore.httpCookieStore;
    BOOL canFlush = [store respondsToSelector:NSSelectorFromString(@"_flushCookiesToDiskWithCompletionHandler:")];
    NSArray *events = [NSUserDefaults.standardUserDefaults arrayForKey:kEventLogKey] ?: @[];
    NSArray *recent = events.count > 60 ? [events subarrayWithRange:NSMakeRange(events.count - 60, 60)] : events;

    return [NSString stringWithFormat:@"iOS %ld.%ld.%ld, app %@, mic permission %@, audio %@, background audio %@, cookie flush %@\n"
            "storage on disk (folders of 0.5 MB or more):\n%@\n"
            "app events (latest last):\n%@\n----",
            (long)os.majorVersion, (long)os.minorVersion, (long)os.patchVersion,
            appVersion ?: @"?", micPermission, [self audioRouteSummary],
            [[NSBundle.mainBundle objectForInfoDictionaryKey:@"UIBackgroundModes"] containsObject:@"audio"] ? @"yes" : @"no",
            canFlush ? @"available" : @"not available",
            [self storageSummary],
            recent.count ? [recent componentsJoinedByString:@"\n"] : @"(none)"];
}

/// Sizes of the folders WebKit keeps website data in (IndexedDB, CacheStorage,
/// local storage, its network cache) and of the app's module store, to see what
/// fills claude.ai's storage quota. Folder names only, never file contents.
- (NSString *)storageSummary {
    NSURL *library = [[NSFileManager.defaultManager URLsForDirectory:NSLibraryDirectory
                                                           inDomains:NSUserDomainMask] firstObject];
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (NSString *top in @[@"WebKit", @"Caches"]) {
        [self addFolderSizes:[library URLByAppendingPathComponent:top isDirectory:YES]
                        name:top
                       depth:0
                        into:lines];
    }
    return lines.count ? [lines componentsJoinedByString:@"\n"] : @"  (nothing)";
}

/// Adds "name size" for this folder (before its subfolders) when it holds 0.5 MB
/// or more, going four levels down; returns the folder's size in bytes.
- (long long)addFolderSizes:(NSURL *)folder
                       name:(NSString *)name
                      depth:(NSInteger)depth
                       into:(NSMutableArray<NSString *> *)lines
{
    NSArray<NSURL *> *children = [NSFileManager.defaultManager contentsOfDirectoryAtURL:folder
                                                           includingPropertiesForKeys:@[NSURLIsDirectoryKey, NSURLTotalFileAllocatedSizeKey]
                                                                              options:0
                                                                                error:nil];
    NSUInteger insertAt = lines.count;
    long long total = 0;
    for (NSURL *child in children) {
        id isDirectory = nil;
        [child getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:nil];
        if ([isDirectory boolValue]) {
            NSString *childName = [name stringByAppendingFormat:@"/%@", child.lastPathComponent];
            total += depth < 4
                ? [self addFolderSizes:child name:childName depth:depth + 1 into:lines]
                : [self sizeOfFolder:child];
        } else {
            id size = nil;
            [child getResourceValue:&size forKey:NSURLTotalFileAllocatedSizeKey error:nil];
            total += [size longLongValue];
        }
    }
    if (total >= 512 * 1024 && lines.count < 40) {
        [lines insertObject:[NSString stringWithFormat:@"  %@ %.1f MB", name, total / 1048576.0] atIndex:insertAt];
    }
    return total;
}

- (long long)sizeOfFolder:(NSURL *)folder {
    NSDirectoryEnumerator *walk = [NSFileManager.defaultManager enumeratorAtURL:folder
                                                     includingPropertiesForKeys:@[NSURLTotalFileAllocatedSizeKey]
                                                                        options:0
                                                                   errorHandler:nil];
    long long total = 0;
    for (NSURL *file in walk) {
        id size = nil;
        [file getResourceValue:&size forKey:NSURLTotalFileAllocatedSizeKey error:nil];
        total += [size longLongValue];
    }
    return total;
}

/// Adds a line to the app's own event log, which survives reloads and launches.
- (void)logEvent:(NSString *)text {
    if (text.length == 0) {
        return;
    }
    static NSDateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss";
    });
    NSString *line = [NSString stringWithFormat:@"%@ %@", [formatter stringFromDate:[NSDate date]], text];
    NSLog(@"[event] %@", text);
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    NSMutableArray *log = [[defaults arrayForKey:kEventLogKey] mutableCopy] ?: [NSMutableArray array];
    [log addObject:line];
    if (log.count > kEventLogLimit) {
        [log removeObjectsInRange:NSMakeRange(0, log.count - kEventLogLimit)];
    }
    [defaults setObject:log forKey:kEventLogKey];
}

- (void)copyDebugLog {
    NSString *header = [self nativeDebugSummary];
    __weak typeof(self) weakSelf = self;
    [self.webView evaluateJavaScript:@"window.__appDebugLog ? window.__appDebugLog() : 'page log unavailable'"
                   completionHandler:^(id result, NSError *error) {
        NSString *pageLog = [result isKindOfClass:NSString.class]
            ? result
            : [NSString stringWithFormat:@"(could not read page log: %@)", error.localizedDescription];
        UIPasteboard.generalPasteboard.string = [NSString stringWithFormat:@"%@\n%@", header, pageLog];

        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }
        UIAlertController *done = [UIAlertController alertControllerWithTitle:@"Debug log copied"
                                                                      message:nil
                                                               preferredStyle:UIAlertControllerStyleAlert];
        [done addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
        [[strongSelf topPresenter] presentViewController:done animated:YES completion:nil];
    }];
}

/// Adds a line to the page-side debug log (and the device console).
- (void)appendDebugLog:(NSString *)line {
    NSLog(@"[app] %@", line);
    NSData *json = [NSJSONSerialization dataWithJSONObject:@[line ?: @""] options:0 error:nil];
    if (json == nil) {
        return;
    }
    NSString *array = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    NSString *js = [NSString stringWithFormat:@"window.__appLogNative && window.__appLogNative(%@[0])", array];
    [self.webView evaluateJavaScript:js completionHandler:nil];
}

#pragma mark - Session cookies

// claude.ai keeps you signed in with persistent cookies. WebKit writes cookie
// changes to disk some time after they happen; if iOS ends the app before that
// (common when it is in the background), the newest cookies are lost and the
// next launch presents old ones, which the server can refuse — a sign-out out of
// nowhere. The app therefore:
//  - asks WebKit to write cookies to disk whenever they change and when the app
//    goes to the background (where this iOS version offers that);
//  - keeps its own copy of claude.ai's persistent cookies in the app's data
//    folder (same protection class iOS uses for WebKit's cookie file, excluded
//    from backups), and at launch puts back any that are missing or older;
//  - logs when the sign-in cookie changes or disappears, by fingerprint only.
// Signing in itself is never automated: when claude.ai signs you out, its own
// sign-in page and email verification are used as normal.

- (WKHTTPCookieStore *)cookieStore {
    return self.webView.configuration.websiteDataStore.httpCookieStore;
}

- (NSURL *)sessionBackupURL {
    NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                       inDomains:NSUserDomainMask] firstObject];
    [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
    return [dir URLByAppendingPathComponent:kSessionBackupFile];
}

- (BOOL)isClaudeCookie:(NSHTTPCookie *)cookie {
    NSString *domain = cookie.domain.lowercaseString;
    if ([domain hasPrefix:@"."]) {
        domain = [domain substringFromIndex:1];
    }
    return [domain isEqualToString:@"claude.ai"];
}

- (NSString *)cookieKey:(NSHTTPCookie *)cookie {
    return [NSString stringWithFormat:@"%@|%@|%@", cookie.name, cookie.domain.lowercaseString, cookie.path ?: @"/"];
}

- (NSHTTPCookie *)signInCookieIn:(NSArray<NSHTTPCookie *> *)cookies {
    for (NSHTTPCookie *cookie in cookies) {
        if ([cookie.name isEqualToString:@"sessionKey"] && [self isClaudeCookie:cookie]) {
            return cookie;
        }
    }
    return nil;
}

- (NSString *)describeSignInCookie:(NSHTTPCookie *)cookie {
    if (cookie == nil) {
        return @"no sign-in cookie";
    }
    NSString *expiry = @"no expiry";
    if (cookie.expiresDate) {
        double days = [cookie.expiresDate timeIntervalSinceNow] / 86400.0;
        expiry = [NSString stringWithFormat:@"expires in %.1f days", days];
    }
    return [NSString stringWithFormat:@"sign-in cookie %@ (%@)", ShortFingerprint(cookie.value), expiry];
}

/// Only plain values go into the copy (property lists cannot hold NSURL).
- (NSDictionary *)plainProperties:(NSHTTPCookie *)cookie {
    NSMutableDictionary *plain = [NSMutableDictionary dictionary];
    [cookie.properties enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
        if (![key isKindOfClass:NSString.class]) {
            return;
        }
        if ([value isKindOfClass:NSString.class] || [value isKindOfClass:NSNumber.class] || [value isKindOfClass:NSDate.class]) {
            plain[key] = value;
        } else if ([value isKindOfClass:NSURL.class]) {
            plain[key] = [value absoluteString];
        }
    }];
    return plain;
}

- (void)saveSessionCookies:(NSArray<NSHTTPCookie *> *)cookies {
    NSMutableArray *entries = [NSMutableArray array];
    for (NSHTTPCookie *cookie in cookies) {
        // Session-only cookies are meant to end with the app, so they stay out.
        if (![self isClaudeCookie:cookie] || cookie.sessionOnly || cookie.expiresDate == nil) {
            continue;
        }
        [entries addObject:[self plainProperties:cookie]];
    }
    NSDictionary *backup = @{@"savedAt": [NSDate date], @"cookies": entries};
    NSError *error = nil;
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:backup
                                                              format:NSPropertyListBinaryFormat_v1_0
                                                             options:0
                                                               error:&error];
    if (data == nil) {
        NSLog(@"[session] could not encode cookies: %@", error);
        return;
    }
    NSURL *url = [self sessionBackupURL];
    if (![data writeToURL:url
                  options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication
                    error:&error]) {
        NSLog(@"[session] could not save cookies: %@", error);
        return;
    }
    [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}

- (NSArray<NSHTTPCookie *> *)backedUpCookies:(NSDate **)savedAt {
    NSData *data = [NSData dataWithContentsOfURL:[self sessionBackupURL]];
    if (data == nil) {
        return @[];
    }
    id plist = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:nil];
    if (![plist isKindOfClass:NSDictionary.class]) {
        return @[];
    }
    if (savedAt && [plist[@"savedAt"] isKindOfClass:NSDate.class]) {
        *savedAt = plist[@"savedAt"];
    }
    NSMutableArray *cookies = [NSMutableArray array];
    for (id entry in plist[@"cookies"]) {
        if (![entry isKindOfClass:NSDictionary.class]) {
            continue;
        }
        NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:entry];
        if (cookie && [self isClaudeCookie:cookie] && cookie.expiresDate && [cookie.expiresDate timeIntervalSinceNow] > 60) {
            [cookies addObject:cookie];
        }
    }
    return cookies;
}

/// At launch, before claude.ai loads: puts back cookies that WebKit lost.
- (void)restoreSessionCookiesThen:(void (^)(void))next {
    WKHTTPCookieStore *store = [self cookieStore];
    NSDate *savedAt = nil;
    NSArray<NSHTTPCookie *> *backup = [self backedUpCookies:&savedAt];

    __weak typeof(self) weakSelf = self;
    [store getAllCookies:^(NSArray<NSHTTPCookie *> *live) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }
        NSMutableDictionary *liveByKey = [NSMutableDictionary dictionary];
        for (NSHTTPCookie *cookie in live) {
            liveByKey[[strongSelf cookieKey:cookie]] = cookie;
        }
        NSMutableArray<NSHTTPCookie *> *restore = [NSMutableArray array];
        for (NSHTTPCookie *saved in backup) {
            NSHTTPCookie *current = liveByKey[[strongSelf cookieKey:saved]];
            if (current == nil) {
                [restore addObject:saved];
            } else if (![current.value isEqualToString:saved.value] && current.expiresDate &&
                       [saved.expiresDate timeIntervalSinceDate:current.expiresDate] > 3600) {
                // The copy was refreshed later than what WebKit kept on disk.
                [restore addObject:saved];
            }
        }

        NSHTTPCookie *liveSignIn = [strongSelf signInCookieIn:live];
        NSHTTPCookie *savedSignIn = [strongSelf signInCookieIn:backup];
        NSString *summary = [NSString stringWithFormat:@"launch: %@", [strongSelf describeSignInCookie:liveSignIn]];
        if (restore.count > 0) {
            NSMutableArray *names = [NSMutableArray array];
            for (NSHTTPCookie *cookie in restore) {
                [names addObject:cookie.name];
            }
            summary = [summary stringByAppendingFormat:@"; put back %lu cookie(s) from the app's copy saved %.0f min ago: %@",
                       (unsigned long)restore.count, savedAt ? -[savedAt timeIntervalSinceNow] / 60.0 : -1,
                       [names componentsJoinedByString:@", "]];
            if (savedSignIn && [restore containsObject:savedSignIn]) {
                summary = [summary stringByAppendingFormat:@" (%@)", [strongSelf describeSignInCookie:savedSignIn]];
            }
        }
        [strongSelf logEvent:summary];

        NSHTTPCookie *effective = (savedSignIn && [restore containsObject:savedSignIn]) ? savedSignIn : liveSignIn;
        strongSelf.sessionFingerprint = effective ? ShortFingerprint(effective.value) : nil;

        dispatch_group_t group = dispatch_group_create();
        for (NSHTTPCookie *cookie in restore) {
            dispatch_group_enter(group);
            [store setCookie:cookie completionHandler:^{
                dispatch_group_leave(group);
            }];
        }
        dispatch_group_notify(group, dispatch_get_main_queue(), ^{
            typeof(self) innerSelf = weakSelf;
            if (innerSelf && !innerSelf.observingCookies) {
                [store addObserver:innerSelf];
                innerSelf.observingCookies = YES;
            }
            if (restore.count > 0) {
                [innerSelf flushCookies];
            }
            next();
        });
    }];
}

- (void)cookiesDidChangeInCookieStore:(WKHTTPCookieStore *)cookieStore {
    // Cookies often change in bursts; save once things are quiet for a second.
    [self.cookieSaveTimer invalidate];
    self.cookieSaveTimer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                            target:self
                                                          selector:@selector(captureCookies)
                                                          userInfo:nil
                                                           repeats:NO];
}

- (void)captureCookies {
    [self captureCookiesThen:nil];
}

- (void)captureCookiesThen:(void (^)(void))done {
    __weak typeof(self) weakSelf = self;
    [[self cookieStore] getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            if (done) done();
            return;
        }
        [strongSelf saveSessionCookies:cookies];
        NSHTTPCookie *signIn = [strongSelf signInCookieIn:cookies];
        NSString *fingerprint = signIn ? ShortFingerprint(signIn.value) : nil;
        if (!(fingerprint == strongSelf.sessionFingerprint || [fingerprint isEqualToString:strongSelf.sessionFingerprint])) {
            [strongSelf logEvent:[NSString stringWithFormat:@"sign-in cookie changed: %@ -> %@",
                                  strongSelf.sessionFingerprint ?: @"none",
                                  signIn ? [strongSelf describeSignInCookie:signIn] : @"removed"]];
            strongSelf.sessionFingerprint = fingerprint;
        }
        [strongSelf flushCookies];
        if (done) done();
    }];
}

/// WebKit's own "write cookies to disk now" (private interface, used only when
/// this iOS version has it).
- (void)flushCookies {
    WKHTTPCookieStore *store = [self cookieStore];
    SEL flush = NSSelectorFromString(@"_flushCookiesToDiskWithCompletionHandler:");
    if ([store respondsToSelector:flush]) {
        void (^completion)(void) = ^{};
        ((void (*)(id, SEL, id))objc_msgSend)(store, flush, completion);
    }
}

- (void)logSessionCookieState:(NSString *)when {
    __weak typeof(self) weakSelf = self;
    [[self cookieStore] getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
        typeof(self) strongSelf = weakSelf;
        [strongSelf logEvent:[NSString stringWithFormat:@"%@: %@", when,
                              [strongSelf describeSignInCookie:[strongSelf signInCookieIn:cookies]]]];
    }];
}

#pragma mark - Background and foreground

- (void)sceneDidEnterBackground:(NSNotification *)notification {
    [self logEvent:@"app went to the background"];
    // Save cookies before iOS suspends the app; ask for a few seconds to do it.
    __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
    task = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Save session" expirationHandler:^{
        [UIApplication.sharedApplication endBackgroundTask:task];
        task = UIBackgroundTaskInvalid;
    }];
    [self captureCookiesThen:^{
        if (task != UIBackgroundTaskInvalid) {
            [UIApplication.sharedApplication endBackgroundTask:task];
            task = UIBackgroundTaskInvalid;
        }
    }];
}

- (void)sceneWillEnterForeground:(NSNotification *)notification {
    [self logEvent:@"app came back to the foreground"];
    if (self.reloadWhenActive) {
        [self reloadAfterTermination];
    }
}

- (void)sceneDidActivate:(NSNotification *)notification {
    if (self.reloadWhenActive) {
        [self reloadAfterTermination];
    }
    if (![self presentQueuedURLIfAny]) {
        [self offerCopiedSignInLink];
    }
}

- (BOOL)presentQueuedURLIfAny {
    if (gQueuedAppURL == nil || !self.startedLoading || self.view.window == nil) {
        return NO;
    }
    NSURL *url = gQueuedAppURL;
    gQueuedAppURL = nil;
    [self openClaudeURL:url source:@"a link"];
    return YES;
}

#pragma mark - Sign-in links

// When claude.ai signs you out, its email sign-in link opens in Safari, which on
// iOS 16 cannot run claude.ai. Three ways to finish signing in inside the app,
// each of them started by you:
//  - copy the link from the email and open the app: on the sign-in page it
//    offers to open the copied link;
//  - three-finger menu > Open copied link;
//  - in Safari, a bookmark that reopens the current page in the app through the
//    claudelegacy:// address (see CLAUDE.md for the bookmarklet).
// Every link is shown and needs a tap to open, and only claude.ai addresses are
// accepted. Codes typed into claude.ai's own sign-in page work as they are.

+ (void)queueAppURL:(NSURL *)url {
    gQueuedAppURL = url;
}

/// claudelegacy://claude.ai/<path>?<query>#<fragment>, or
/// claudelegacy://open?url=<https://claude.ai/...>, or a plain https://claude.ai link.
+ (NSURL *)claudeURLFromAppURL:(NSURL *)url {
    if (url == nil) {
        return nil;
    }
    NSURL *target = url;
    NSString *scheme = url.scheme.lowercaseString;
    if ([scheme isEqualToString:@"claudelegacy"]) {
        if ([url.host.lowercaseString isEqualToString:@"open"]) {
            NSURLComponents *parts = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
            NSString *value = nil;
            for (NSURLQueryItem *item in parts.queryItems) {
                if ([item.name isEqualToString:@"url"]) {
                    value = item.value;
                }
            }
            target = value ? [NSURL URLWithString:value] : nil;
        } else {
            NSString *rest = [url.absoluteString substringFromIndex:@"claudelegacy://".length];
            target = [NSURL URLWithString:[@"https://" stringByAppendingString:rest]];
        }
    }
    if (target == nil || ![target.scheme.lowercaseString isEqualToString:@"https"] ||
        ![target.host.lowercaseString isEqualToString:@"claude.ai"] || target.port != nil ||
        target.user != nil || target.password != nil) {
        return nil;
    }
    return target;
}

- (NSString *)describeLinkForPrompt:(NSURL *)url {
    NSString *path = url.path.length ? url.path : @"/";
    if ([path hasPrefix:@"/magic-link"]) {
        return @"claude.ai sign-in link (from the email claude.ai sent you)";
    }
    return [@"claude.ai" stringByAppendingString:path];
}

/// Opens a claude.ai address in the app after you confirm it.
- (void)openClaudeURL:(NSURL *)url source:(NSString *)source {
    if (url == nil) {
        return;
    }
    if (!self.startedLoading) {
        gQueuedAppURL = url;
        return;
    }
    __weak typeof(self) weakSelf = self;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Open in Claude?"
                                                                   message:[self describeLinkForPrompt:url]
                                                            preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Open" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
        [weakSelf logEvent:[NSString stringWithFormat:@"opened %@ from %@", url.path.length ? url.path : @"/", source]];
        [weakSelf.webView loadRequest:[NSURLRequest requestWithURL:url]];
    }]];
    [[self topPresenter] presentViewController:alert animated:YES completion:nil];
}

- (void)handleAppURL:(NSURL *)url {
    NSURL *target = [ViewController claudeURLFromAppURL:url];
    if (target == nil) {
        [self logEvent:@"ignored an app link that was not a claude.ai address"];
        return;
    }
    [self openClaudeURL:target source:@"a link"];
}

- (NSURL *)copiedClaudeURL {
    UIPasteboard *board = UIPasteboard.generalPasteboard;
    NSURL *url = board.URL;
    if (url == nil && board.hasStrings) {
        NSString *text = [board.string stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        url = text.length ? [NSURL URLWithString:text] : nil;
    }
    return [ViewController claudeURLFromAppURL:url];
}

- (void)openCopiedLink {
    NSURL *url = [self copiedClaudeURL];
    if (url == nil) {
        UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"No claude.ai link copied"
                                                                       message:@"In the email from claude.ai, press and hold the sign-in link, choose Copy, then try again."
                                                                preferredStyle:UIAlertControllerStyleAlert];
        [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
        [[self topPresenter] presentViewController:alert animated:YES completion:nil];
        return;
    }
    [self openClaudeURL:url source:@"the clipboard"];
}

/// On claude.ai's sign-in pages only: if a link has been copied since the last
/// offer, ask whether to open it. Reading it happens only after you agree (iOS
/// then asks for permission to paste).
- (void)offerCopiedSignInLink {
    NSString *path = self.webView.URL.path ?: @"";
    BOOL signInPage = [self isClaudeHost:self.webView.URL.host] &&
        ([path hasPrefix:@"/login"] || [path hasPrefix:@"/magic-link"]);
    UIPasteboard *board = UIPasteboard.generalPasteboard;
    if (!signInPage || !board.hasURLs || board.changeCount == self.offeredPasteboardChange ||
        self.presentedViewController != nil || self.view.window == nil) {
        return;
    }
    self.offeredPasteboardChange = board.changeCount;
    __weak typeof(self) weakSelf = self;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Use the copied link?"
                                                                   message:@"If you copied the sign-in link from claude.ai's email, it can be opened here."
                                                            preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"Not now" style:UIAlertActionStyleCancel handler:nil]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Check link" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
        [weakSelf openCopiedLink];
    }]];
    [self presentViewController:alert animated:YES completion:nil];
}

#pragma mark - Audio routing

- (NSString *)audioRouteSummary {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    NSMutableArray<NSString *> *outputs = [NSMutableArray array];
    for (AVAudioSessionPortDescription *port in session.currentRoute.outputs) {
        [outputs addObject:port.portType];
    }
    return [NSString stringWithFormat:@"category %@, output %@",
            session.category, [outputs componentsJoinedByString:@"+"]];
}

- (void)audioRouteChanged:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self routeToSpeakerIfOnReceiver];
    });
}

/// When the microphone is live, iOS can move playback to the earpiece. Voice
/// mode is meant to be heard from the loudspeaker, so move it back — but only
/// from the earpiece, never away from headphones or Bluetooth.
- (void)routeToSpeakerIfOnReceiver {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    BOOL onReceiver = NO;
    for (AVAudioSessionPortDescription *port in session.currentRoute.outputs) {
        if ([port.portType isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
            onReceiver = YES;
        }
    }

    if (onReceiver && [session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord]) {
        NSError *error = nil;
        BOOL ok = [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:&error];
        NSString *line = @"audio: moved playback from earpiece to speaker";
        if (!ok) {
            line = [NSString stringWithFormat:@"audio: speaker override failed: %@", error.localizedDescription];
        }
        [self appendDebugLog:line];
    } else {
        [self appendDebugLog:[NSString stringWithFormat:@"audio: route changed, %@", [self audioRouteSummary]]];
    }
}

#pragma mark - Loading overlay

- (void)showLoadingOverlay {
    if (self.loadingOverlay.superview != nil) {
        return;
    }

    LoadingOverlayView *overlay = [[LoadingOverlayView alloc] initWithFrame:self.view.bounds];
    overlay.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [self.view addSubview:overlay];
    self.loadingOverlay = overlay;

    [overlay setStage:@"Starting" detail:nil];

    self.modulesExpected = [[NSUserDefaults standardUserDefaults] integerForKey:kModuleCountKey];
    [self resetLoadingProgress];
}

- (void)resetLoadingProgress {
    self.modulesDone = 0;
    self.pendingScripts = 0;
    self.pageReady = NO;
    self.navigationFinished = NO;
    self.showingFailure = NO;
    self.moduleFailure = nil;
    self.lastActivity = [NSDate date];
    self.loadingStartedAt = [NSDate date];

    [self.settleTimer invalidate];
    self.settleTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                        target:self
                                                      selector:@selector(checkIfSettled)
                                                      userInfo:nil
                                                       repeats:YES];
}

- (BOOL)isLoadingOverlayVisible {
    return self.loadingOverlay.superview != nil;
}

- (void)noteActivity {
    self.lastActivity = [NSDate date];
}

/// Dismisses the overlay once module activity has stopped, or after a hard timeout.
- (void)checkIfSettled {
    if (![self isLoadingOverlayVisible]) {
        [self.settleTimer invalidate];
        self.settleTimer = nil;
        return;
    }

    NSTimeInterval elapsed = [[NSDate date] timeIntervalSinceDate:self.loadingStartedAt];

    if (elapsed > kLoadingTimeout) {
        NSLog(@"[loading] timed out after %.0fs", kLoadingTimeout);
        // Out of time. If application code did run, the app is most likely just slow
        // — show it rather than accusing it of failing.
        if (self.pageReady || self.modulesDone > 0) {
            [self finishLoading];
        } else {
            [self showFailure:@"Claude is taking longer than expected to load."
                      details:[self errorDetails]];
        }
        return;
    }

    if (self.pendingScripts > 0) {
        return;
    }

    NSTimeInterval idle = [[NSDate date] timeIntervalSinceDate:self.lastActivity];
    if (self.pageReady) {
        if (idle >= kSettleAfterReadySignal) {
            [self finishLoading];
        }
        return;
    }

    // No ready signal from the page: wait until the navigation itself finished
    // and nothing has been transpiled for a while, then decide whether the page
    // simply had nothing to transpile or actually failed.
    if (!self.navigationFinished) {
        return;
    }

    // A module failed to execute, so the import graph is stuck: waiting for a paint
    // that cannot happen only delays telling the user. A late "ready" still cancels
    // this, see -handleLoadingStatus:.
    if (self.moduleFailure != nil && idle >= kSettleAfterModuleFailure) {
        [self showFailure:@"Claude could not be started on this iOS version."
                  details:[self errorDetails]];
        return;
    }

    if (idle < kSettleWithoutReadySignal) {
        return;
    }

    if (self.modulesDone == 0) {
        [self showFailure:@"The page loaded but no application code was executed."
                  details:@"No script was intercepted by the transpiler."];
        return;
    }

    if (self.lastErrorMessage != nil) {
        // Modules ran but nothing is on screen yet. Errors are common on the way up
        // and harmless — only conclude failure once the app has had long enough to
        // paint, and let a late "ready" cancel it (see -handleLoadingStatus:).
        if (elapsed >= kMinimumElapsedBeforeErrorScreen) {
            [self showFailure:@"Claude could not be started on this iOS version."
                      details:[self errorDetails]];
        }
        return;
    }

    [self finishLoading];
}

- (void)finishLoading {
    [self.settleTimer invalidate];
    self.settleTimer = nil;

    if (self.modulesDone > 0) {
        [[NSUserDefaults standardUserDefaults] setInteger:self.modulesDone forKey:kModuleCountKey];
    }

    [self.loadingOverlay setStage:@"Ready" detail:nil];
    [self.loadingOverlay setProgress:1.0 animated:YES];
    [self.loadingOverlay dismiss];
}

- (void)updateModuleProgress {
    if (![self isLoadingOverlayVisible]) {
        return;
    }

    float progress;
    if (self.modulesExpected > 0) {
        float ratio = MIN(1.0f, (float)self.modulesDone / (float)self.modulesExpected);
        progress = 0.28f + 0.67f * ratio;
    } else {
        // First launch: no estimate of the module count, approach 0.88 asymptotically.
        progress = 0.28f + 0.6f * (1.0f - expf(-(float)self.modulesDone / 30.0f));
    }
    [self.loadingOverlay setProgress:progress animated:YES];
}

- (NSString *)moduleStageText {
    if (self.modulesExpected > 0) {
        return [NSString stringWithFormat:@"Compiling modules · %ld/%ld",
                (long)MIN(self.modulesDone, self.modulesExpected), (long)self.modulesExpected];
    }
    if (self.modulesDone > 0) {
        return [NSString stringWithFormat:@"Compiling modules · %ld", (long)self.modulesDone];
    }
    return @"Compiling modules";
}

/// Turns the overlay into an error screen. Keeps the overlay up on purpose: a
/// failed load leaves a blank web view behind, which tells the user nothing.
- (void)showFailure:(NSString *)message details:(NSString *)details {
    // The overlay is not shown at launch, so it is put up for the error: a failed
    // load would otherwise leave a blank screen with nothing to tap.
    if (![self isLoadingOverlayVisible]) {
        [self showLoadingOverlay];
    }

    NSLog(@"[loading] failed: %@ (%@)", message, details);

    self.showingFailure = YES;
    [self.settleTimer invalidate];
    self.settleTimer = nil;

    __weak typeof(self) weakSelf = self;
    [self.loadingOverlay showErrorWithMessage:message details:details retryHandler:^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }
        [strongSelf.loadingOverlay resetToLoading];
        [strongSelf.loadingOverlay setStage:@"Connecting to claude.ai" detail:nil];
        strongSelf.lastErrorMessage = nil;
        strongSelf.errorCount = 0;
        [strongSelf resetLoadingProgress];
        // After a first load that failed there is no page to reload.
        if (strongSelf.webView.URL != nil) {
            [strongSelf.webView reload];
        } else {
            [strongSelf.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"https://claude.ai"]]];
        }
    } continueHandler:^{
        typeof(self) strongSelf = weakSelf;
        [strongSelf.loadingOverlay dismiss];
        // With the page process gone there is nothing behind the overlay:
        // "Continue" has to bring the page back, not reveal a blank screen.
        if (strongSelf.failureNeedsReload) {
            strongSelf.failureNeedsReload = NO;
            [strongSelf reloadAfterTermination];
        }
    }];
}

- (void)showFailureForError:(NSError *)error {
    // Network failures only (offline, timeout, no DNS, TLS): other errors here
    // are WebKit reporting a load it stopped itself, with the page still working.
    if (![error.domain isEqualToString:NSURLErrorDomain]) {
        return;
    }
    [self logEvent:[NSString stringWithFormat:@"page load failed: %@ (%ld)", error.localizedDescription, (long)error.code]];
    NSString *details = error.userInfo[@"WKJavaScriptExceptionMessage"] ?: error.localizedDescription;
    [self showFailure:@"Could not load claude.ai." details:details];
}

/// claude.ai ships no version number, and its entry chunk is served as
/// `index-<hash>.js` with the hash changing on every deploy — so that hash is the
/// closest thing to a build identifier. The module file names already reach us
/// through the loading messages, so it is picked out of those.
- (void)noteSiteBuildFromFile:(NSString *)file {
    if (![file isKindOfClass:NSString.class] ||
        ![file hasPrefix:@"index-"] || ![file hasSuffix:@".js"]) {
        return;
    }

    NSUInteger prefix = @"index-".length;
    NSUInteger suffix = @".js".length;
    if (file.length <= prefix + suffix) {
        return;
    }

    NSString *build = [file substringWithRange:NSMakeRange(prefix, file.length - prefix - suffix)];
    if (build.length == 0 || [build isEqualToString:self.siteBuild]) {
        return;
    }

    self.siteBuild = build;
    [self.loadingOverlay setSiteBuild:build];
    NSLog(@"[loading] claude.ai build %@", build);
}

/// Remembers the first failure seen while loading; -checkIfSettled decides
/// whether it actually kept the page from starting.
- (void)recordErrorMessage:(NSString *)message {
    if (message.length == 0 || self.pageReady) {
        return;
    }
    NSLog(@"[loading] error while loading: %@", message);
    self.errorCount += 1;
    if (self.lastErrorMessage == nil) {
        self.lastErrorMessage = message;
    }
}

/// First error plus how many followed it — the rest are usually the same cause.
- (NSString *)errorDetails {
    if (self.lastErrorMessage == nil) {
        return nil;
    }
    if (self.errorCount > 1) {
        return [NSString stringWithFormat:@"%@\n\n+ %ld more error(s)",
                self.lastErrorMessage, (long)(self.errorCount - 1)];
    }
    return self.lastErrorMessage;
}

#pragma mark - KVO

- (void)observeValueForKeyPath:(NSString *)keyPath
                     ofObject:(id)object
                       change:(NSDictionary *)change
                      context:(void *)context {
    if (![keyPath isEqualToString:@"estimatedProgress"]) {
        return;
    }
    if (![self isLoadingOverlayVisible] || self.modulesDone > 0) {
        return;
    }
    // The page fetch itself only accounts for the first quarter of the bar.
    [self.loadingOverlay setProgress:0.05f + 0.20f * self.webView.estimatedProgress animated:YES];
}

#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    BOOL mainFrame = navigationAction.targetFrame == nil || [navigationAction.targetFrame isMainFrame];

    if (mainFrame && [self isAppHandoffURL:url]) {
        [self openExternalURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }

    // A tapped link that leaves claude.ai opens in Safari instead of replacing Claude.
    if (mainFrame
        && navigationAction.navigationType == WKNavigationTypeLinkActivated
        && [self isWebURL:url]
        && ![self isClaudeHost:url.host]) {
        [self openExternalURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }

    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
    if ([self isLoadingOverlayVisible]) {
        [self.loadingOverlay setStage:@"Connecting to claude.ai" detail:webView.URL.host];
        [self noteActivity];
    }
}

- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
    if ([self isLoadingOverlayVisible] && self.modulesDone == 0) {
        [self.loadingOverlay setStage:@"Loading page" detail:webView.URL.path];
        [self noteActivity];
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.navigationFinished = YES;
    if ([self isLoadingOverlayVisible] && self.modulesDone == 0) {
        [self.loadingOverlay setStage:@"Starting Claude" detail:nil];
        [self.loadingOverlay setProgress:0.28 animated:YES];
    }
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (error.code != NSURLErrorCancelled) {
        [self showFailureForError:error];
    }
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (error.code != NSURLErrorCancelled) {
        [self showFailureForError:error];
    }
}

/// iOS stops the page's process when it needs memory, usually while the app is
/// in the background. The page is reloaded where it was (the same chat) instead
/// of leaving a blank view; only repeated stops in a short time show the error.
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    NSDate *now = [NSDate date];
    [self.terminations addObject:now];
    NSIndexSet *old = [self.terminations indexesOfObjectsPassingTest:^BOOL(NSDate *date, NSUInteger idx, BOOL *stop) {
        return [now timeIntervalSinceDate:date] > 90;
    }];
    [self.terminations removeObjectsAtIndexes:old];

    BOOL active = UIApplication.sharedApplication.applicationState == UIApplicationStateActive;
    [self logEvent:[NSString stringWithFormat:@"page process stopped by iOS (%@, %lu in the last 90 s)",
                    active ? @"app open" : @"app in background", (unsigned long)self.terminations.count]];

    if (self.terminations.count >= 3) {
        [self showLoadingOverlay];
        self.failureNeedsReload = YES;
        [self showFailure:@"The page keeps stopping — the device may be short of memory."
                  details:@"Close other apps, then tap Reload."];
        return;
    }
    if (active) {
        [self reloadAfterTermination];
    } else {
        self.reloadWhenActive = YES;
    }
}

- (void)reloadAfterTermination {
    self.reloadWhenActive = NO;
    NSURL *url = self.webView.URL;
    if (url == nil || ![self isWebURL:url] || ![self isClaudeHost:url.host]) {
        url = [NSURL URLWithString:@"https://claude.ai"];
    }
    [self logEvent:[NSString stringWithFormat:@"reloading %@ after the page process stopped", url.path.length ? url.path : @"/"]];
    [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
}

#pragma mark - WKUIDelegate

/// Links with target="_blank" and window.open(): claude.ai pages stay in the app,
/// everything else opens in the in-app Safari sheet.
- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
    NSURL *url = navigationAction.request.URL;
    if ([self isWebURL:url] && [self isClaudeHost:url.host]) {
        [webView loadRequest:navigationAction.request];
    } else {
        [self openExternalURL:url];
    }
    return nil;
}

/// Voice mode needs the microphone. Grant it to claude.ai without WebKit asking
/// again every session (iOS itself still asks once, the first time).
- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
                          initiatedByFrame:(WKFrameInfo *)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:(void (^)(WKPermissionDecision decision))decisionHandler API_AVAILABLE(ios(15.0)) {
    // Only claude.ai itself, from its top-level page: subdomains and embedded
    // frames host other content (previews, artifacts) and are refused.
    BOOL trusted = [origin.protocol isEqualToString:@"https"]
        && [origin.host.lowercaseString isEqualToString:@"claude.ai"]
        && frame.isMainFrame;
    WKPermissionDecision decision;
    if (!trusted) {
        decision = WKPermissionDecisionDeny;
    } else if (type == WKMediaCaptureTypeMicrophone) {
        decision = WKPermissionDecisionGrant;
    } else {
        decision = WKPermissionDecisionPrompt;
    }
    [self appendDebugLog:[NSString stringWithFormat:@"mic: %@ asked for capture type %ld, decision %ld",
                          origin.host, (long)type, (long)decision]];
    decisionHandler(decision);
}

#pragma mark - WKScriptMessageHandler

/// Messages are accepted only from claude.ai's own top-level page. Every frame on
/// the page, including embedded third-party and user-generated content
/// (artifacts, previews, video players), can reach window.webkit.messageHandlers,
/// and "patchScript" runs code in the page: without this check an embedded frame
/// could run code with access to the signed-in claude.ai session.
- (BOOL)isTrustedMessage:(WKScriptMessage *)message {
    return IsTrustedFrame(message.frameInfo);
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
{
    if (![self isTrustedMessage:message]) {
        NSLog(@"[bridge] ignored %@ from %@://%@ (main frame %d)", message.name,
              message.frameInfo.securityOrigin.protocol, message.frameInfo.securityOrigin.host,
              message.frameInfo.isMainFrame);
        return;
    }

    if ([message.name isEqualToString:@"appEvent"]) {
        if ([message.body isKindOfClass:NSString.class]) {
            NSString *text = message.body;
            [self logEvent:[@"page: " stringByAppendingString:[text substringToIndex:MIN(text.length, (NSUInteger)400)]]];
            if ([text hasPrefix:@"signed out"] || [text hasPrefix:@"api 401"] || [text hasPrefix:@"api 403"]) {
                [self logSessionCookieState:@"at that moment"];
            }
        }
        return;
    }

    if ([message.name isEqualToString:@"loadingStatus"]) {
        [self handleLoadingStatus:message.body];
        return;
    }

    if ([message.name isEqualToString:@"chrome"]) {
        [self handleChromeState:message.body];
        return;
    }

    if ([message.name isEqualToString:@"appearance"]) {
        [self handleAppearance:message.body];
        return;
    }

    if (![message.name isEqualToString:@"patchScript"]) {
        return;
    }

    NSString *code = message.body;
    NSString *file = nil;
    if ([message.body isKindOfClass:NSDictionary.class]) {
        code = message.body[@"code"];
        file = message.body[@"file"];
    }
    if (![code isKindOfClass:NSString.class]) {
        return;
    }

    [self noteActivity];
    [self noteSiteBuildFromFile:file];
    if ([self isLoadingOverlayVisible]) {
        self.pendingScripts += 1;
        [self.loadingOverlay setStage:[self moduleStageText] detail:file];
    }

    NSString *wrapped = [NSString stringWithFormat:@"%@\n;'ok'", code];

    __weak typeof(self) weakSelf = self;
    [self.webView evaluateJavaScript:wrapped completionHandler:^(id res, NSError *err) {
        if (err) {
            NSLog(@"[evaluateJavaScript]: fail %@", code);
        } else {
            NSLog(@"[evaluateJavaScript]: success"); // always return a serializable value
        }

        typeof(self) strongSelf = weakSelf;
        if (!strongSelf) {
            return;
        }
        if (err) {
            NSString *reason = err.userInfo[@"WKJavaScriptExceptionMessage"] ?: err.localizedDescription;
            NSString *detail = [NSString stringWithFormat:@"%@: %@", file ?: @"module", reason];
            [strongSelf recordErrorMessage:detail];
            if (strongSelf.moduleFailure == nil) {
                strongSelf.moduleFailure = detail;
            }
        }
        [strongSelf noteActivity];
        strongSelf.modulesDone += 1;
        if ([strongSelf isLoadingOverlayVisible]) {
            strongSelf.pendingScripts = MAX(0, strongSelf.pendingScripts - 1);
            [strongSelf.loadingOverlay setStage:[strongSelf moduleStageText] detail:file];
            [strongSelf updateModuleProgress];
        }
    }];
}

- (void)handleLoadingStatus:(id)body {
    if (![body isKindOfClass:NSDictionary.class]) {
        return;
    }
    NSString *stage = body[@"stage"];
    NSString *file = body[@"file"];

    // Modules run inside the page (fast loading) never pass through
    // -userContentController:didReceiveScriptMessage:, so they are counted here.
    if ([stage isEqualToString:@"module"]) {
        [self noteActivity];
        self.modulesDone += 1;
        if ([self isLoadingOverlayVisible]) {
            [self noteSiteBuildFromFile:file];
            [self.loadingOverlay setStage:[self moduleStageText] detail:file];
            [self updateModuleProgress];
        }
        return;
    }
    if ([stage isEqualToString:@"inline-refused"]) {
        [self logEvent:[NSString stringWithFormat:@"page refused in-page modules (at %@); running them through the app", file]];
        return;
    }
    if ([stage isEqualToString:@"error"] && [body[@"fatal"] boolValue]) {
        NSString *fatalMessage = [body[@"message"] isKindOfClass:NSString.class] ? body[@"message"] : @"Unknown JavaScript error";
        [self recordErrorMessage:fatalMessage];
        [self showFailure:@"Claude could not be started on this iOS version." details:fatalMessage];
        return;
    }
    if (![self isLoadingOverlayVisible]) {
        return;
    }

    if ([stage isEqualToString:@"boot"]) {
        [self noteActivity];
        [self.loadingOverlay setStage:@"Patching JavaScript engine" detail:nil];
    } else if ([stage isEqualToString:@"download"]) {
        [self noteActivity];
        [self noteSiteBuildFromFile:file];
        [self.loadingOverlay setStage:self.modulesDone > 0 ? [self moduleStageText] : @"Downloading modules"
                              detail:file];
    } else if ([stage isEqualToString:@"ready"]) {
        self.pageReady = YES;
        if (self.showingFailure) {
            // The page rendered after all, so the error screen was premature.
            NSLog(@"[loading] page became ready after the error screen — dismissing it");
            [self finishLoading];
        }
    } else if ([stage isEqualToString:@"error"]) {
        NSString *jsMessage = [body[@"message"] isKindOfClass:NSString.class] ? body[@"message"] : @"Unknown JavaScript error";
        [self recordErrorMessage:jsMessage];
    }
}

@end
