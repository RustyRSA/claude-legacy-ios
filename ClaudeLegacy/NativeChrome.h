//
//  NativeChrome.h
//  ClaudeLegacy
//
//  The native top bar and message bar over the page (rounds 12-21).
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

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
@property (nonatomic, copy, nullable) void (^onAction)(NSString *name, NSString * _Nullable argument);
- (void)applyState:(NSDictionary *)state;
/// After a send: clears the box when it worked and gives the keyboard back.
- (void)finishSend:(BOOL)sent;
/// The app's message box has the keyboard.
@property (nonatomic, readonly) BOOL editing;
/// At launch, when the controls were in use last time: shown at once, with the
/// buttons off until the page reports.
- (void)showWhileLoading;
/// Covers the page between the bars (plain background and a spinner) until the
/// page reports that the app's controls are in use: while claude.ai loads it
/// draws its own message box several times over, in different places, and
/// hiding each of those in time proved unreliable (rounds 16–19). At most 8 s.
- (void)coverPage;
/// The model button's native menu: asks for claude.ai's menu items
/// ({index, title, subtitle, checked, disabled, sub}; none = show claude.ai's
/// own menu, nil = it is already showing), and reports the item picked.
@property (nonatomic, copy, nullable) void (^onMenuItems)(NSString *menu, void (^completion)(NSArray<NSDictionary *> * _Nullable items));
@property (nonatomic, copy, nullable) void (^onMenuPick)(NSString *menu, NSDictionary *item);
/// How much of the screen's bottom the message bar takes (points above the safe
/// area's bottom edge; 0 when it is not shown): the page ends there.
@property (nonatomic, copy, nullable) void (^onBarInset)(CGFloat inset);
/// Height of the message bar now, with a text of several lines.
@property (nonatomic, readonly) CGFloat barHeight;
/// The message bar (it rides on the keyboard): the page ends at its top.
@property (nonatomic, readonly) UIView *messageBar;
/// The page's edge colours, and whether the page is dark (the controls then use
/// the dark system colours whatever the phone is set to).
- (void)setTopColor:(UIColor *)top bottomColor:(UIColor *)bottom dark:(BOOL)dark;
@end

NS_ASSUME_NONNULL_END
