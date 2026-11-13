//
//  ChatListViewController.h
//  ClaudeLegacy
//
//  The native chat list (round 13c): the chats claude.ai's own page has listed,
//  kept on the phone so the list opens at once, also while the page still loads.
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Chat ids, names and last-changed times as the page reported them (app-tweaks.js,
/// "chatList" handler). Kept in the app's data folder (not backed up); names are
/// never written to any log. Main thread only.
@interface ChatListStore : NSObject

/// Newest first. Each entry: id (NSString), name (NSString), updated (NSNumber,
/// milliseconds since 1970, 0 when unknown), seen (NSDate).
+ (NSArray<NSDictionary *> *)chats;

/// Adds or refreshes chats from the page. Entries without a valid id are skipped.
+ (void)mergeChats:(NSArray *)items;

/// The sections of claude.ai's sidebar in its order (Starred, your own groups,
/// Recents). Each: name (NSString, may be empty), chats (array of {path, name};
/// path is the item's claude.ai address: /chat/…, /artifact/…, /code/…, /project/…).
/// A section reported without items (closed in claude.ai) keeps its last items.
+ (NSArray<NSDictionary *> *)groups;
+ (void)setGroups:(NSArray *)groups;

@end

/// "Chats": search, New chat, the chats, a row that opens claude.ai's own menu
/// for everything else (projects, settings), and a row for the app's menu.
@interface ChatListViewController : UITableViewController <UISearchResultsUpdating>

/// path: /chat/<id> or another item address from a section.
@property (nonatomic, copy, nullable) void (^onOpenPath)(NSString *path);
@property (nonatomic, copy, nullable) void (^onNewChat)(void);
@property (nonatomic, copy, nullable) void (^onShowClaudeMenu)(void);
/// The app's own menu (reload, page size, advanced, debug log).
@property (nonatomic, copy, nullable) void (^onShowAppMenu)(void);

@end

NS_ASSUME_NONNULL_END
