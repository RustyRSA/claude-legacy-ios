//
//  AppShared.h
//  ClaudeLegacy
//
//  Small pieces shared by ViewController.m, NativeChrome.m and ModuleStore.m.
//

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

/// Background behind the web page, matching claude.ai's own theme colours
/// (#FCFCFB light, #151515 dark) so no off-colour band shows while it loads.
static inline UIColor *AppBackgroundColor(void) {
    return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *tc) {
        return tc.userInterfaceStyle == UIUserInterfaceStyleDark
        ? [UIColor colorWithRed:0x15/255.0 green:0x15/255.0 blue:0x15/255.0 alpha:1.0]
        : [UIColor colorWithRed:0xFC/255.0 green:0xFC/255.0 blue:0xFB/255.0 alpha:1.0];
    }];
}

/// Height of the native top bar below the status bar (points): what it takes to
/// cover claude.ai's own top bar, as last reported by the page.
static NSString *const kChromeTopHeightKey = @"NativeTopBarHeight";

/// Messages are accepted only from claude.ai's own top-level page, see
/// -isTrustedMessage: in ViewController.m.
static inline BOOL IsTrustedFrame(WKFrameInfo *frame) {
    WKSecurityOrigin *origin = frame.securityOrigin;
    return frame.isMainFrame
        && [origin.protocol isEqualToString:@"https"]
        && [origin.host.lowercaseString isEqualToString:@"claude.ai"]
        && origin.port == 0;
}
