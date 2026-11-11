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

@end

/// "Chats": search, New chat, the chats, and a row that opens claude.ai's own
/// menu for everything else (projects, settings).
@interface ChatListViewController : UITableViewController <UISearchResultsUpdating>

@property (nonatomic, copy, nullable) void (^onOpenChat)(NSString *chatID);
@property (nonatomic, copy, nullable) void (^onNewChat)(void);
@property (nonatomic, copy, nullable) void (^onShowClaudeMenu)(void);

@end

NS_ASSUME_NONNULL_END
