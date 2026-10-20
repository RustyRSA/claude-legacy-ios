//
//  ViewController.m
//  ClaudePatcher
//
//  Created by Efimov.mg on 23/2/2026.
//
#import <objc/runtime.h>
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

@interface ViewController () <WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate, UIGestureRecognizerDelegate>

@property (nonatomic) IBOutlet WKWebView *webView;

/// Status bar text colour, set from the page's own background (see -handleAppearance:).
@property (nonatomic, assign) UIStatusBarStyle pageStatusBarStyle;

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

    // Edge to edge, like the native app: claude.ai declares viewport-fit=cover and
    // pads its own header and message box with env(safe-area-inset-*), so the page
    // itself fills the status-bar and home-indicator areas.
    [self pinWebViewToScreenEdges];
    _webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;

    // No pull-to-refresh and no rubber-banding of the whole page (the chat list
    // still scrolls and bounces inside it). Reload lives in the three-finger menu.
    _webView.scrollView.bounces = NO;
    _webView.scrollView.alwaysBounceVertical = NO;
    _webView.scrollView.alwaysBounceHorizontal = NO;

    // No long-press link previews.
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

    [self.webView addObserver:self forKeyPath:@"estimatedProgress" options:0 context:NULL];

    // Three-finger long press opens a small menu: Reload / Copy debug log.
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

    //[self showLoadingOverlay];

    // Injecting the polyfills reads a few hundred files off disk, so give the
    // overlay a chance to reach the screen before blocking the main thread.
    dispatch_async(dispatch_get_main_queue(), ^{
        [self startLoading];
    });
}

- (void)dealloc {
    [_settleTimer invalidate];
    [_webView removeObserver:self forKeyPath:@"estimatedProgress"];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

/// Replaces the storyboard's safe-area constraints: top and bottom go to the
/// screen edges, sides stay inside the safe area (keeps landscape clear of the
/// Dynamic Island; in portrait the side insets are zero anyway).
- (void)pinWebViewToScreenEdges {
    NSMutableArray<NSLayoutConstraint *> *old = [NSMutableArray array];
    for (NSLayoutConstraint *constraint in self.view.constraints) {
        if (constraint.firstItem == _webView || constraint.secondItem == _webView) {
            [old addObject:constraint];
        }
    }
    [NSLayoutConstraint deactivateConstraints:old];

    _webView.translatesAutoresizingMaskIntoConstraints = NO;
    UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[
        [_webView.topAnchor constraintEqualToAnchor:self.view.topAnchor],
        [_webView.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [_webView.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor],
        [_webView.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
    ]];
}

- (void)startLoading {
    [self.loadingOverlay setStage:@"Preparing compatibility layer" detail:nil];

    [self injectScriptNamed:@"app-tweaks"];
    [self injectIOSVersion];
    [self injectCustomCSS];
    [self injectScriptNamed:@"legacy-transpiler"];
    [self injectScriptNamed:@"patch"];
    [PolyfillsLoader injectPolyfillsIntoController:_webView.configuration.userContentController];

    [self.loadingOverlay setProgress:0.05 animated:YES];
    [self.loadingOverlay setStage:@"Connecting to claude.ai" detail:nil];

    [_webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"https://claude.ai"]]];
//    [_webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"http://192.168.1.136:3000"]]];
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    return self.pageStatusBarStyle;
}

#pragma mark - App feel

/// The page reports the colour actually drawn under the status bar (app-tweaks.js).
/// Matching it keeps the status bar readable when Claude's theme differs from the
/// phone's, and keeps any uncovered edge the same colour as the page.
- (void)handleAppearance:(id)body {
    if (![body isKindOfClass:NSDictionary.class]) {
        return;
    }
    NSNumber *r = body[@"r"];
    NSNumber *g = body[@"g"];
    NSNumber *b = body[@"b"];
    if (![r isKindOfClass:NSNumber.class] || ![g isKindOfClass:NSNumber.class] || ![b isKindOfClass:NSNumber.class]) {
        return;
    }

    CGFloat red = MIN(MAX(r.doubleValue / 255.0, 0.0), 1.0);
    CGFloat green = MIN(MAX(g.doubleValue / 255.0, 0.0), 1.0);
    CGFloat blue = MIN(MAX(b.doubleValue / 255.0, 0.0), 1.0);
    self.view.backgroundColor = [UIColor colorWithRed:red green:green blue:blue alpha:1.0];

    CGFloat luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    UIStatusBarStyle style = luminance < 0.5 ? UIStatusBarStyleLightContent : UIStatusBarStyleDarkContent;
    if (style != self.pageStatusBarStyle) {
        self.pageStatusBarStyle = style;
        [self setNeedsStatusBarAppearanceUpdate];
    }
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
    [sheet addAction:[UIAlertAction actionWithTitle:@"Copy debug log"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
        [weakSelf copyDebugLog];
    }]];
    [sheet addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];

    // iPad presents action sheets as popovers, which need an anchor.
    sheet.popoverPresentationController.sourceView = self.view;
    sheet.popoverPresentationController.sourceRect =
        CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1);
    [self presentViewController:sheet animated:YES completion:nil];
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

    return [NSString stringWithFormat:@"iOS %ld.%ld.%ld, app %@, mic permission %@, audio %@",
            (long)os.majorVersion, (long)os.minorVersion, (long)os.patchVersion,
            appVersion ?: @"?", micPermission, [self audioRouteSummary]];
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
    if (![self isLoadingOverlayVisible]) {
        return;
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
        [strongSelf resetLoadingProgress];
        [strongSelf.webView reload];
    } continueHandler:^{
        typeof(self) strongSelf = weakSelf;
        [strongSelf.loadingOverlay dismiss];
    }];
}

- (void)showFailureForError:(NSError *)error {
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

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [self showLoadingOverlay];
    [self showFailure:@"The web process stopped — the device may have run out of memory."
              details:nil];
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
    BOOL trusted = [origin.protocol isEqualToString:@"https"] && [self isClaudeHost:origin.host];
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

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
{
    if ([message.name isEqualToString:@"loadingStatus"]) {
        [self handleLoadingStatus:message.body];
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
    if (![body isKindOfClass:NSDictionary.class] || ![self isLoadingOverlayVisible]) {
        return;
    }

    NSString *stage = body[@"stage"];
    NSString *file = body[@"file"];

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
        if ([body[@"fatal"] boolValue]) {
            [self showFailure:@"Claude could not be started on this iOS version."
                      details:jsMessage];
        }
    }
}

@end
