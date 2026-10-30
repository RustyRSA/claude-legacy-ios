//
//  ViewController.h
//  ClaudeLegacy
//
//  Created by user on 3/9/26.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ViewController : UIViewController

/// A claude.ai address to open once the page is set up (cold start from a link).
+ (void)queueAppURL:(NSURL *)url;
/// The https://claude.ai address an app link stands for, or nil if it is not one.
+ (nullable NSURL *)claudeURLFromAppURL:(NSURL *)url;
/// Opens an app link (claudelegacy://...) after asking.
- (void)handleAppURL:(NSURL *)url;

@end

NS_ASSUME_NONNULL_END
