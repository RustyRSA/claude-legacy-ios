//
//  ChatCopy.m
//  ClaudeLegacy
//

#import "ChatCopy.h"

static NSString *const kChatCopiesKey = @"ChatCopies";
static NSString *const kChatCopyFolder = @"chat-copies";
static const NSUInteger kChatCopyLimit = 50;
/// Characters kept per chat (the page sends at most this much, the newest).
static const NSUInteger kChatCopyTextLimit = 1500000;

#pragma mark - Store

@implementation ChatCopyStore

/// Chat id -> when its copy was saved, for every copy on disk.
static NSMutableDictionary<NSString *, NSDate *> *gSaved = nil;

+ (dispatch_queue_t)queue {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("ClaudeLegacy.chatCopies", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

+ (NSURL *)folderURL {
    NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                           inDomains:NSUserDomainMask] firstObject];
    return [support URLByAppendingPathComponent:kChatCopyFolder isDirectory:YES];
}

+ (BOOL)isChatID:(id)value {
    if (![value isKindOfClass:NSString.class] || [(NSString *)value length] != 36) {
        return NO;
    }
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF-"];
    return [(NSString *)value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

/// Named by the chat's id only, which is checked: no other name can be made.
+ (NSURL *)fileFor:(NSString *)chatID {
    return [[self folderURL] URLByAppendingPathComponent:[chatID.lowercaseString stringByAppendingString:@".plist"]];
}

+ (void)loadIndexIfNeeded {
    if (gSaved != nil) {
        return;
    }
    gSaved = [NSMutableDictionary dictionary];
    NSArray<NSURL *> *files = [NSFileManager.defaultManager contentsOfDirectoryAtURL:[self folderURL]
                                                          includingPropertiesForKeys:@[NSURLContentModificationDateKey]
                                                                             options:NSDirectoryEnumerationSkipsHiddenFiles
                                                                               error:nil];
    for (NSURL *file in files) {
        NSString *name = file.lastPathComponent;
        NSString *chatID = [name stringByDeletingPathExtension];
        if (![name hasSuffix:@".plist"] || ![self isChatID:chatID]) {
            continue;
        }
        id date = nil;
        [file getResourceValue:&date forKey:NSURLContentModificationDateKey error:nil];
        gSaved[chatID.lowercaseString] = [date isKindOfClass:NSDate.class] ? date : [NSDate distantPast];
    }
}

+ (BOOL)enabled {
    id value = [NSUserDefaults.standardUserDefaults objectForKey:kChatCopiesKey];
    return [value isKindOfClass:NSNumber.class] ? [value boolValue] : YES;
}

+ (void)setEnabled:(BOOL)enabled {
    [NSUserDefaults.standardUserDefaults setBool:enabled forKey:kChatCopiesKey];
    if (enabled) {
        return;
    }
    [self loadIndexIfNeeded];
    [gSaved removeAllObjects];
    NSURL *folder = [self folderURL];
    dispatch_async([self queue], ^{
        [NSFileManager.defaultManager removeItemAtURL:folder error:nil];
    });
}

+ (void)saveChat:(NSDictionary *)chat {
    if (![self enabled] || ![chat isKindOfClass:NSDictionary.class] || ![self isChatID:chat[@"id"]]) {
        return;
    }
    NSString *chatID = [(NSString *)chat[@"id"] lowercaseString];
    NSArray *list = [chat[@"messages"] isKindOfClass:NSArray.class] ? chat[@"messages"] : @[];
    NSMutableArray<NSDictionary *> *messages = [NSMutableArray arrayWithCapacity:list.count];
    NSUInteger characters = 0;
    for (id item in list) {
        if (![item isKindOfClass:NSDictionary.class]) {
            continue;
        }
        NSDictionary *message = item;
        NSString *text = [message[@"text"] isKindOfClass:NSString.class] ? message[@"text"] : @"";
        if (text.length == 0) {
            continue;
        }
        if (characters + text.length > kChatCopyTextLimit) {
            break;
        }
        characters += text.length;
        NSNumber *at = [message[@"at"] isKindOfClass:NSNumber.class] ? message[@"at"] : @0;
        [messages addObject:@{@"role": [message[@"role"] isEqual:@"user"] ? @"user" : @"assistant",
                              @"text": text,
                              @"at": at}];
    }
    if (messages.count == 0) {
        return;
    }
    NSString *name = [chat[@"name"] isKindOfClass:NSString.class] ? chat[@"name"] : @"";
    if (name.length > 200) {
        name = [name substringToIndex:200];
    }
    NSNumber *updated = [chat[@"updated"] isKindOfClass:NSNumber.class] ? chat[@"updated"] : @0;
    BOOL earlier = [chat[@"earlier"] isKindOfClass:NSNumber.class] && [chat[@"earlier"] boolValue];
    NSDate *now = [NSDate date];
    NSDictionary *entry = @{@"id": chatID, @"name": name, @"updated": updated, @"savedAt": now,
                            @"earlier": @(earlier), @"messages": messages};

    [self loadIndexIfNeeded];
    gSaved[chatID] = now;
    // Beyond the limit, the copies saved longest ago go.
    NSMutableArray<NSURL *> *dropped = [NSMutableArray array];
    if (gSaved.count > kChatCopyLimit) {
        NSArray<NSString *> *byAge = [gSaved keysSortedByValueUsingSelector:@selector(compare:)];
        for (NSString *old in [byAge subarrayWithRange:NSMakeRange(0, gSaved.count - kChatCopyLimit)]) {
            [dropped addObject:[self fileFor:old]];
            [gSaved removeObjectForKey:old];
        }
    }
    NSURL *folder = [self folderURL];
    NSURL *file = [self fileFor:chatID];
    dispatch_async([self queue], ^{
        NSFileManager *files = NSFileManager.defaultManager;
        if (![files fileExistsAtPath:folder.path]) {
            [files createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
            [folder setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
        }
        NSData *data = [NSPropertyListSerialization dataWithPropertyList:entry
                                                                  format:NSPropertyListBinaryFormat_v1_0
                                                                 options:0
                                                                   error:nil];
        // Readable only while the phone is unlocked (a write while it is locked
        // simply fails: the chat is saved the next time claude.ai opens it).
        if (data != nil) {
            [data writeToURL:file options:NSDataWritingAtomic | NSDataWritingFileProtectionComplete error:nil];
        }
        for (NSURL *old in dropped) {
            [files removeItemAtURL:old error:nil];
        }
    });
}

+ (BOOL)hasChat:(NSString *)chatID {
    if (![self isChatID:chatID]) {
        return NO;
    }
    [self loadIndexIfNeeded];
    return gSaved[chatID.lowercaseString] != nil;
}

+ (void)loadChat:(NSString *)chatID completion:(void (^)(NSDictionary *))completion {
    if (![self hasChat:chatID]) {
        completion(nil);
        return;
    }
    NSURL *file = [self fileFor:chatID];
    dispatch_async([self queue], ^{
        NSData *data = [NSData dataWithContentsOfURL:file];
        id plist = data ? [NSPropertyListSerialization propertyListWithData:data
                                                                    options:NSPropertyListImmutable
                                                                     format:NULL
                                                                      error:nil] : nil;
        NSDictionary *chat = nil;
        if ([plist isKindOfClass:NSDictionary.class] && [((NSDictionary *)plist)[@"messages"] isKindOfClass:NSArray.class]) {
            chat = plist;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(chat);
        });
    });
}

+ (void)removeChat:(NSString *)chatID {
    if (![self hasChat:chatID]) {
        return;
    }
    [gSaved removeObjectForKey:chatID.lowercaseString];
    NSURL *file = [self fileFor:chatID];
    dispatch_async([self queue], ^{
        [NSFileManager.defaultManager removeItemAtURL:file error:nil];
    });
}

+ (void)keepOnly:(NSSet<NSString *> *)chatIDs {
    if (chatIDs.count == 0) {
        return;
    }
    [self loadIndexIfNeeded];
    NSMutableArray<NSURL *> *gone = [NSMutableArray array];
    for (NSString *chatID in gSaved.allKeys) {
        if (![chatIDs containsObject:chatID]) {
            [gone addObject:[self fileFor:chatID]];
            [gSaved removeObjectForKey:chatID];
        }
    }
    if (gone.count == 0) {
        return;
    }
    dispatch_async([self queue], ^{
        for (NSURL *file in gone) {
            [NSFileManager.defaultManager removeItemAtURL:file error:nil];
        }
    });
}

+ (NSString *)summary {
    [self loadIndexIfNeeded];
    return [NSString stringWithFormat:@"chat copies %@ (%lu chats on the phone)",
            [self enabled] ? @"on" : @"off", (unsigned long)gSaved.count];
}

@end

#pragma mark - Viewer

@implementation ChatCopyViewController {
    NSDictionary *_chat;
    UITextView *_textView;
    UIActivityIndicatorView *_spinner;
    /// Where the last message starts: shown at the top once the text is laid out.
    NSUInteger _lastStart;
    BOOL _scrollPending;
}

- (instancetype)initWithChat:(NSDictionary *)chat {
    self = [super initWithNibName:nil bundle:nil];
    if (self) {
        _chat = chat;
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.systemBackgroundColor;
    NSString *name = [_chat[@"name"] isKindOfClass:NSString.class] ? _chat[@"name"] : @"";
    self.title = name.length ? name : @"Chat";
    self.navigationItem.largeTitleDisplayMode = UINavigationItemLargeTitleDisplayModeNever;

    _textView = [[UITextView alloc] init];
    _textView.translatesAutoresizingMaskIntoConstraints = NO;
    _textView.editable = NO;
    _textView.selectable = YES;
    _textView.alwaysBounceVertical = YES;
    _textView.backgroundColor = UIColor.systemBackgroundColor;
    _textView.textContainerInset = UIEdgeInsetsMake(12, 12, 32, 12);
    _textView.dataDetectorTypes = UIDataDetectorTypeLink;
    _textView.delegate = self;
    [self.view addSubview:_textView];

    _spinner = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleMedium];
    _spinner.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:_spinner];
    [NSLayoutConstraint activateConstraints:@[
        [_textView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
        [_textView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [_textView.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [_textView.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [_spinner.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [_spinner.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
    ]];

    NSMutableArray<UIBarButtonItem *> *items = [NSMutableArray array];
    [items addObject:[[UIBarButtonItem alloc] initWithTitle:@"Open in Claude"
                                                      style:UIBarButtonItemStyleDone
                                                     target:self
                                                     action:@selector(openInClaude)]];
    if (@available(iOS 16.0, *)) {
        _textView.findInteractionEnabled = YES;
        UIBarButtonItem *find = [[UIBarButtonItem alloc] initWithImage:[UIImage systemImageNamed:@"magnifyingglass"]
                                                                 style:UIBarButtonItemStylePlain
                                                                target:self
                                                                action:@selector(findInChat)];
        find.accessibilityLabel = @"Find in chat";
        [items addObject:find];
    }
    self.navigationItem.rightBarButtonItems = items;

    // Long chats take a moment to lay out: built away from the main thread.
    [_spinner startAnimating];
    NSDictionary *chat = _chat;
    UIColor *tint = self.view.tintColor ?: UIColor.systemBlueColor;
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSUInteger lastStart = 0;
        NSAttributedString *text = [ChatCopyViewController textForChat:chat tint:tint lastStart:&lastStart];
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf showText:text lastStart:lastStart];
        });
    });
}

- (void)showText:(NSAttributedString *)text lastStart:(NSUInteger)lastStart {
    [_spinner stopAnimating];
    _textView.attributedText = text;
    _lastStart = MIN(lastStart, text.length > 0 ? text.length - 1 : 0);
    _scrollPending = text.length > 0;
    [self.view setNeedsLayout];
}

/// As in a chat: the latest message in view, from its start.
- (void)viewDidLayoutSubviews {
    [super viewDidLayoutSubviews];
    if (!_scrollPending || _textView.bounds.size.height <= 0) {
        return;
    }
    _scrollPending = NO;
    UITextPosition *start = [_textView positionFromPosition:_textView.beginningOfDocument offset:(NSInteger)_lastStart];
    UITextPosition *end = start ? [_textView positionFromPosition:start offset:1] : nil;
    UITextRange *range = (start && end) ? [_textView textRangeFromPosition:start toPosition:end] : nil;
    CGRect rect = range ? [_textView firstRectForRange:range] : CGRectNull;
    if (CGRectIsNull(rect) || CGRectIsInfinite(rect)) {
        [_textView scrollRangeToVisible:NSMakeRange(_lastStart, 1)];
        return;
    }
    UIEdgeInsets insets = _textView.adjustedContentInset;
    CGFloat lowest = -insets.top;
    CGFloat highest = MAX(lowest, _textView.contentSize.height + insets.bottom - _textView.bounds.size.height);
    CGFloat y = MIN(MAX(rect.origin.y - 12 - insets.top, lowest), highest);
    [_textView setContentOffset:CGPointMake(0, y) animated:NO];
}

- (void)openInClaude {
    void (^open)(void) = self.onOpenInClaude;
    UIViewController *presenter = self.navigationController.presentingViewController;
    if (presenter != nil) {
        [presenter dismissViewControllerAnimated:YES completion:nil];
    }
    if (open) {
        open();
    }
}

- (void)findInChat API_AVAILABLE(ios(16.0)) {
    [_textView.findInteraction presentFindNavigatorShowingReplace:NO];
}

- (BOOL)textView:(UITextView *)textView
    shouldInteractWithURL:(NSURL *)URL
                  inRange:(NSRange)characterRange
              interaction:(UITextItemInteraction)interaction {
    // A tap opens the link the app's way; a long press keeps the system menu.
    if (interaction != UITextItemInteractionInvokeDefaultAction || self.onOpenURL == nil) {
        return YES;
    }
    self.onOpenURL(URL);
    return NO;
}

#pragma mark Text

/// The whole chat as text: a line saying when the copy was made, then each
/// message under "You" or "Claude" and its time.
+ (NSAttributedString *)textForChat:(NSDictionary *)chat tint:(UIColor *)tint lastStart:(NSUInteger *)lastStart {
    UIFont *body = [UIFont systemFontOfSize:17];
    UIFont *mono = [UIFont monospacedSystemFontOfSize:15 weight:UIFontWeightRegular];
    UIFont *header = [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold];
    UIFont *note = [UIFont systemFontOfSize:13];
    NSDateFormatter *dates = [[NSDateFormatter alloc] init];
    dates.dateStyle = NSDateFormatterMediumStyle;
    dates.timeStyle = NSDateFormatterShortStyle;
    dates.doesRelativeDateFormatting = YES;

    NSMutableParagraphStyle *spaced = [[NSMutableParagraphStyle alloc] init];
    spaced.paragraphSpacingBefore = 6;
    NSMutableAttributedString *out = [[NSMutableAttributedString alloc] init];

    NSDate *saved = [chat[@"savedAt"] isKindOfClass:NSDate.class] ? chat[@"savedAt"] : nil;
    NSString *about = saved
        ? [NSString stringWithFormat:@"Copy on this phone from %@. Anything newer is in Claude.", [dates stringFromDate:saved]]
        : @"Copy on this phone. Anything newer is in Claude.";
    if ([chat[@"earlier"] isKindOfClass:NSNumber.class] && [chat[@"earlier"] boolValue]) {
        about = [about stringByAppendingString:@" The oldest messages are not in the copy."];
    }
    [out appendAttributedString:[[NSAttributedString alloc] initWithString:about attributes:@{
        NSFontAttributeName: note, NSForegroundColorAttributeName: UIColor.secondaryLabelColor}]];

    NSArray *messages = [chat[@"messages"] isKindOfClass:NSArray.class] ? chat[@"messages"] : @[];
    for (id item in messages) {
        if (![item isKindOfClass:NSDictionary.class]) {
            continue;
        }
        NSDictionary *message = item;
        NSString *text = [message[@"text"] isKindOfClass:NSString.class] ? message[@"text"] : @"";
        if (text.length == 0) {
            continue;
        }
        BOOL user = [message[@"role"] isEqual:@"user"];
        double at = [message[@"at"] isKindOfClass:NSNumber.class] ? [message[@"at"] doubleValue] : 0;
        NSString *who = user ? @"You" : @"Claude";
        if (at > 0) {
            who = [who stringByAppendingFormat:@"  ·  %@", [dates stringFromDate:[NSDate dateWithTimeIntervalSince1970:at / 1000.0]]];
        }
        [out appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n\n" attributes:@{NSFontAttributeName: body}]];
        if (lastStart) {
            *lastStart = out.length;
        }
        [out appendAttributedString:[[NSAttributedString alloc] initWithString:[who stringByAppendingString:@"\n"] attributes:@{
            NSFontAttributeName: header,
            NSForegroundColorAttributeName: user ? tint : UIColor.secondaryLabelColor,
            NSParagraphStyleAttributeName: spaced}]];
        [out appendAttributedString:[self markdown:text body:body mono:mono]];
    }
    return out;
}

/// claude.ai writes Markdown: fenced code blocks in a fixed-width font, the
/// rest through Foundation's Markdown reader (bold, italic, code, links), and
/// "#" headings in bold.
+ (NSAttributedString *)markdown:(NSString *)text body:(UIFont *)body mono:(UIFont *)mono {
    NSMutableAttributedString *out = [[NSMutableAttributedString alloc] init];
    NSMutableString *chunk = [NSMutableString string];
    BOOL inCode = NO;
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        NSString *trimmed = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if ([trimmed hasPrefix:@"```"]) {
            [self append:chunk code:inCode to:out body:body mono:mono];
            [chunk setString:@""];
            inCode = !inCode;
            continue;
        }
        if (chunk.length > 0) {
            [chunk appendString:@"\n"];
        }
        [chunk appendString:line];
    }
    [self append:chunk code:inCode to:out body:body mono:mono];
    return out;
}

+ (void)append:(NSString *)chunk code:(BOOL)code to:(NSMutableAttributedString *)out body:(UIFont *)body mono:(UIFont *)mono {
    NSString *text = [chunk stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];
    if (text.length == 0) {
        return;
    }
    if (out.length > 0) {
        [out appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n" attributes:@{NSFontAttributeName: body}]];
    }
    if (code) {
        [out appendAttributedString:[[NSAttributedString alloc] initWithString:text attributes:@{
            NSFontAttributeName: mono,
            NSForegroundColorAttributeName: UIColor.labelColor,
            NSBackgroundColorAttributeName: UIColor.tertiarySystemFillColor}]];
        return;
    }
    [out appendAttributedString:[self inlineMarkdown:text body:body mono:mono]];
}

+ (NSAttributedString *)inlineMarkdown:(NSString *)text body:(UIFont *)body mono:(UIFont *)mono {
    NSAttributedStringMarkdownParsingOptions *options = [[NSAttributedStringMarkdownParsingOptions alloc] init];
    options.interpretedSyntax = NSAttributedStringMarkdownInterpretedSyntaxInlineOnlyPreservingWhitespace;
    options.failurePolicy = NSAttributedStringMarkdownParsingFailureReturnPartiallyParsedIfPossible;
    NSAttributedString *parsed = [[NSAttributedString alloc] initWithMarkdownString:text options:options baseURL:nil error:nil];
    NSMutableAttributedString *result = parsed ? [parsed mutableCopy] : [[NSMutableAttributedString alloc] initWithString:text];
    NSRange all = NSMakeRange(0, result.length);
    [result addAttribute:NSFontAttributeName value:body range:all];
    [result addAttribute:NSForegroundColorAttributeName value:UIColor.labelColor range:all];
    [result enumerateAttribute:NSInlinePresentationIntentAttributeName
                       inRange:all
                       options:0
                    usingBlock:^(id value, NSRange range, BOOL *stop) {
        if (![value isKindOfClass:NSNumber.class]) {
            return;
        }
        NSUInteger intent = [(NSNumber *)value unsignedIntegerValue];
        if (intent & NSInlinePresentationIntentCode) {
            [result addAttribute:NSFontAttributeName value:mono range:range];
            [result addAttribute:NSBackgroundColorAttributeName value:UIColor.tertiarySystemFillColor range:range];
        } else {
            UIFontDescriptorSymbolicTraits traits = 0;
            if (intent & NSInlinePresentationIntentStronglyEmphasized) {
                traits |= UIFontDescriptorTraitBold;
            }
            if (intent & NSInlinePresentationIntentEmphasized) {
                traits |= UIFontDescriptorTraitItalic;
            }
            UIFontDescriptor *descriptor = traits ? [body.fontDescriptor fontDescriptorWithSymbolicTraits:traits] : nil;
            if (descriptor != nil) {
                [result addAttribute:NSFontAttributeName value:[UIFont fontWithDescriptor:descriptor size:body.pointSize] range:range];
            }
        }
        if (intent & NSInlinePresentationIntentStrikethrough) {
            [result addAttribute:NSStrikethroughStyleAttributeName value:@(NSUnderlineStyleSingle) range:range];
        }
    }];
    [self markHeadings:result body:body];
    return result;
}

/// Lines that start with "#" to "######" and a space: bold, without the marks.
+ (void)markHeadings:(NSMutableAttributedString *)text body:(UIFont *)body {
    NSString *plain = [text.string copy];
    NSMutableArray<NSValue *> *lines = [NSMutableArray array];
    [plain enumerateSubstringsInRange:NSMakeRange(0, plain.length)
                              options:NSStringEnumerationByLines | NSStringEnumerationSubstringNotRequired
                           usingBlock:^(NSString *substring, NSRange range, NSRange enclosingRange, BOOL *stop) {
        [lines addObject:[NSValue valueWithRange:range]];
    }];
    UIFont *bold = [UIFont systemFontOfSize:body.pointSize + 1 weight:UIFontWeightSemibold];
    // From the end, so the ranges before each change stay right.
    for (NSValue *value in lines.reverseObjectEnumerator) {
        NSRange range = value.rangeValue;
        NSUInteger marks = 0;
        while (marks < range.length && marks < 6 && [plain characterAtIndex:range.location + marks] == '#') {
            marks += 1;
        }
        if (marks == 0 || marks >= range.length || [plain characterAtIndex:range.location + marks] != ' ') {
            continue;
        }
        [text addAttribute:NSFontAttributeName value:bold range:range];
        [text deleteCharactersInRange:NSMakeRange(range.location, marks + 1)];
    }
}

@end
