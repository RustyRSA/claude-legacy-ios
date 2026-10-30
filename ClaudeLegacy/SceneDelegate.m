//
//  SceneDelegate.m
//  ClaudeLegacy
//
//  Created by user on 3/9/26.
//

#import "SceneDelegate.h"
#import "ViewController.h"

@implementation SceneDelegate

/// Started from a claudelegacy:// link: open that claude.ai address first.
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)connectionOptions {
    NSURL *url = connectionOptions.URLContexts.anyObject.URL;
    NSURL *target = url ? [ViewController claudeURLFromAppURL:url] : nil;
    if (target != nil) {
        [ViewController queueAppURL:target];
    }
}

/// A claudelegacy:// link while the app is running: the app asks before opening it.
- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts {
    NSURL *url = URLContexts.anyObject.URL;
    UIViewController *root = self.window.rootViewController;
    if (url != nil && [root isKindOfClass:ViewController.class]) {
        [(ViewController *)root handleAppURL:url];
    }
}

@end
