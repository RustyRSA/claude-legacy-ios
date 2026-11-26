//
//  ChatCopy.h
//  ClaudeLegacy
//
//  Chat copies (round 24): the text of chats claude.ai has opened on this
//  phone, kept by the app and shown natively from the chat list at once.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// The text of recently opened chats. app-tweaks.js hands over what claude.ai
/// itself fetched when it opened a chat; the app makes no request of its own.
/// One file per chat in Application Support/chat-copies, readable only while the
/// phone is unlocked, not backed up, never logged. At most 50 chats (the oldest
/// copy goes); a copy goes with its chat when the chat list drops that chat (not
/// listed or opened for 14 days), when claude.ai says the chat is gone, or when
/// the setting is turned off. Main thread only (files are read and written on a
/// queue of the store's own).
@interface ChatCopyStore : NSObject
/// The "Chat copies" setting (Advanced menu): on unless turned off.
+ (BOOL)enabled;
/// Off: every copy is deleted.
+ (void)setEnabled:(BOOL)enabled;
/// From the page: {id, name, updated, earlier, messages: [{role, text, at}]}.
+ (void)saveChat:(NSDictionary *)chat;
+ (BOOL)hasChat:(NSString *)chatID;
/// Read from its file; the completion runs on the main thread (nil: none).
+ (void)loadChat:(NSString *)chatID completion:(void (^)(NSDictionary * _Nullable chat))completion;
+ (void)removeChat:(NSString *)chatID;
/// The copies of chats not in this set are deleted (the chat list dropped them).
/// An empty set changes nothing.
+ (void)keepOnly:(NSSet<NSString *> *)chatIDs;
/// For the debug log: on or off, and how many chats are kept.
+ (NSString *)summary;
@end

/// One chat's copy, read-only: who wrote what, with the text selectable and
/// links that open; Find searches it (iOS 16). "Open in Claude" goes on to the
/// chat in claude.ai's page, which the chat list has already started opening.
API_AVAILABLE(ios(15.0))
@interface ChatCopyViewController : UIViewController <UITextViewDelegate>
- (instancetype)initWithChat:(NSDictionary *)chat;
@property (nonatomic, copy, nullable) void (^onOpenInClaude)(void);
@property (nonatomic, copy, nullable) void (^onOpenURL)(NSURL *url);
@end

NS_ASSUME_NONNULL_END
