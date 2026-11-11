//
//  ChatListViewController.m
//  ClaudeLegacy
//

#import "ChatListViewController.h"

static NSString *const kChatListFile = @"chat-list.plist";
static const NSUInteger kChatListLimit = 500;
/// Chats the page has not listed again for this long are dropped (deleted
/// chats would otherwise stay for ever).
static const NSTimeInterval kChatListKeep = 14 * 24 * 3600.0;

#pragma mark - Store

@implementation ChatListStore

static NSMutableArray<NSDictionary *> *gChats = nil;

+ (NSURL *)fileURL {
    NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                       inDomains:NSUserDomainMask] firstObject];
    [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
    return [dir URLByAppendingPathComponent:kChatListFile];
}

+ (BOOL)isChatID:(id)value {
    if (![value isKindOfClass:NSString.class] || [(NSString *)value length] != 36) {
        return NO;
    }
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF-"];
    return [(NSString *)value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

/// One entry in the stored shape, or nil when it is not a chat.
+ (NSDictionary *)entryFrom:(id)item seen:(NSDate *)seen {
    if (![item isKindOfClass:NSDictionary.class]) {
        return nil;
    }
    NSDictionary *source = item;
    id chatID = source[@"id"];
    if (![self isChatID:chatID]) {
        return nil;
    }
    NSString *name = [source[@"name"] isKindOfClass:NSString.class] ? source[@"name"] : @"";
    name = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (name.length > 200) {
        name = [name substringToIndex:200];
    }
    NSNumber *updated = [source[@"updated"] isKindOfClass:NSNumber.class] ? source[@"updated"] : @0;
    NSDate *seenAt = [source[@"seen"] isKindOfClass:NSDate.class] ? source[@"seen"] : seen;
    return @{@"id": [(NSString *)chatID lowercaseString],
             @"name": name.length ? name : @"Untitled",
             @"updated": @(MAX(updated.doubleValue, 0)),
             @"seen": seenAt};
}

+ (void)loadIfNeeded {
    if (gChats != nil) {
        return;
    }
    gChats = [NSMutableArray array];
    NSData *data = [NSData dataWithContentsOfURL:[self fileURL]];
    id plist = data ? [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:nil] : nil;
    if (![plist isKindOfClass:NSArray.class]) {
        return;
    }
    NSDate *now = [NSDate date];
    for (id item in (NSArray *)plist) {
        NSDictionary *entry = [self entryFrom:item seen:now];
        if (entry) {
            [gChats addObject:entry];
        }
    }
}

+ (NSArray<NSDictionary *> *)chats {
    [self loadIfNeeded];
    return [gChats copy];
}

+ (void)mergeChats:(NSArray *)items {
    if (![items isKindOfClass:NSArray.class] || items.count == 0) {
        return;
    }
    [self loadIfNeeded];
    NSDate *now = [NSDate date];
    NSMutableDictionary<NSString *, NSNumber *> *indexByID = [NSMutableDictionary dictionary];
    [gChats enumerateObjectsUsingBlock:^(NSDictionary *chat, NSUInteger index, BOOL *stop) {
        indexByID[chat[@"id"]] = @(index);
    }];
    BOOL changed = NO;
    for (id item in items) {
        NSDictionary *source = [item isKindOfClass:NSDictionary.class] ? item : nil;
        NSMutableDictionary *fresh = [source mutableCopy];
        [fresh removeObjectForKey:@"seen"];
        NSDictionary *entry = [self entryFrom:fresh seen:now];
        if (entry == nil) {
            continue;
        }
        NSNumber *index = indexByID[entry[@"id"]];
        if (index == nil) {
            indexByID[entry[@"id"]] = @(gChats.count);
            [gChats addObject:entry];
            changed = YES;
            continue;
        }
        NSDictionary *old = gChats[index.unsignedIntegerValue];
        // A report without a time (names read off the page) keeps the known time.
        NSMutableDictionary *merged = [entry mutableCopy];
        if ([entry[@"updated"] doubleValue] <= 0) {
            merged[@"updated"] = old[@"updated"];
        }
        if (![merged[@"name"] isEqual:old[@"name"]] || ![merged[@"updated"] isEqual:old[@"updated"]]) {
            changed = YES;
        }
        gChats[index.unsignedIntegerValue] = merged;
    }

    // Drop what the page has not listed for a long time, newest first, capped.
    NSIndexSet *stale = [gChats indexesOfObjectsPassingTest:^BOOL(NSDictionary *chat, NSUInteger index, BOOL *stop) {
        return [now timeIntervalSinceDate:chat[@"seen"]] > kChatListKeep;
    }];
    if (stale.count) {
        [gChats removeObjectsAtIndexes:stale];
        changed = YES;
    }
    [gChats sortWithOptions:NSSortStable usingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        double left = [a[@"updated"] doubleValue];
        double right = [b[@"updated"] doubleValue];
        if (left == right) {
            return NSOrderedSame;
        }
        return left > right ? NSOrderedAscending : NSOrderedDescending;
    }];
    if (gChats.count > kChatListLimit) {
        [gChats removeObjectsInRange:NSMakeRange(kChatListLimit, gChats.count - kChatListLimit)];
    }
    [self saveSoon:changed];
}

/// Written at most every few seconds (the "seen" times change at every report),
/// at once when a name, time or the set of chats changed.
+ (void)saveSoon:(BOOL)changed {
    static NSDate *lastSave = nil;
    if (!changed && lastSave != nil && -[lastSave timeIntervalSinceNow] < 60) {
        return;
    }
    lastSave = [NSDate date];
    NSArray *snapshot = [gChats copy];
    NSURL *url = [self fileURL];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSData *data = [NSPropertyListSerialization dataWithPropertyList:snapshot
                                                                  format:NSPropertyListBinaryFormat_v1_0
                                                                 options:0
                                                                   error:nil];
        if (data == nil) {
            return;
        }
        if ([data writeToURL:url
                     options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication
                       error:nil]) {
            [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
        }
    });
}

@end

#pragma mark - List

typedef NS_ENUM(NSInteger, ChatListSection) {
    ChatListSectionActions = 0,
    ChatListSectionChats = 1,
    ChatListSectionMore = 2,
};

@implementation ChatListViewController {
    NSArray<NSDictionary *> *_all;
    NSArray<NSDictionary *> *_shown;
    BOOL _searching;
    NSRelativeDateTimeFormatter *_dates;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.title = @"Chats";
    self.navigationItem.rightBarButtonItem =
        [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone
                                                      target:self
                                                      action:@selector(close)];

    UISearchController *search = [[UISearchController alloc] initWithSearchResultsController:nil];
    search.searchResultsUpdater = self;
    search.obscuresBackgroundDuringPresentation = NO;
    search.searchBar.placeholder = @"Search chats";
    self.navigationItem.searchController = search;
    self.navigationItem.hidesSearchBarWhenScrolling = NO;
    self.definesPresentationContext = YES;

    _dates = [[NSRelativeDateTimeFormatter alloc] init];
    _dates.unitsStyle = NSRelativeDateTimeFormatterUnitsStyleFull;

    _all = [ChatListStore chats];
    _shown = _all;
}

- (void)close {
    [self.presentingViewController dismissViewControllerAnimated:YES completion:nil];
}

/// Closes the list (and the search above it), then runs the action.
- (void)closeThen:(void (^)(void))action {
    UIViewController *presenter = self.navigationController.presentingViewController ?: self.presentingViewController;
    self.navigationItem.searchController.active = NO;
    [presenter dismissViewControllerAnimated:YES completion:^{
        if (action) {
            action();
        }
    }];
}

- (void)updateSearchResultsForSearchController:(UISearchController *)searchController {
    NSString *query = [searchController.searchBar.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    _searching = query.length > 0;
    if (!_searching) {
        _shown = _all;
    } else {
        NSStringCompareOptions options = NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch;
        _shown = [_all filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *chat, NSDictionary *bindings) {
            return [(NSString *)chat[@"name"] rangeOfString:query options:options].location != NSNotFound;
        }]];
    }
    [self.tableView reloadData];
}

#pragma mark Table

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
    return 3;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    if (section == ChatListSectionChats) {
        return (NSInteger)_shown.count;
    }
    return _searching ? 0 : 1;
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
    if (section == ChatListSectionChats && _shown.count == 0) {
        return _searching ? @"No chat with that name in the list on this phone." : @"Chats appear here once Claude has listed them.";
    }
    if (section == ChatListSectionMore && !_searching) {
        return @"The list holds the chats Claude has loaded on this phone. Older chats, projects and settings are in Claude's own menu.";
    }
    return nil;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
    static NSString *const reuse = @"chat";
    UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:reuse];
    if (cell == nil) {
        cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:reuse];
    }
    cell.imageView.image = nil;
    cell.detailTextLabel.text = nil;
    cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
    cell.textLabel.textColor = UIColor.labelColor;
    cell.textLabel.numberOfLines = 1;
    cell.accessoryType = UITableViewCellAccessoryNone;

    if (indexPath.section == ChatListSectionActions) {
        cell.textLabel.text = @"New chat";
        cell.textLabel.textColor = self.view.tintColor;
        cell.imageView.image = [UIImage systemImageNamed:@"square.and.pencil"];
    } else if (indexPath.section == ChatListSectionMore) {
        cell.textLabel.text = @"Claude menu";
        cell.imageView.image = [UIImage systemImageNamed:@"sidebar.left"];
        cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    } else {
        NSDictionary *chat = _shown[(NSUInteger)indexPath.row];
        cell.textLabel.text = chat[@"name"];
        double updated = [chat[@"updated"] doubleValue];
        if (updated > 0) {
            NSDate *date = [NSDate dateWithTimeIntervalSince1970:updated / 1000.0];
            cell.detailTextLabel.text = [_dates localizedStringForDate:date relativeToDate:[NSDate date]];
        }
    }
    return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
    [tableView deselectRowAtIndexPath:indexPath animated:YES];
    if (indexPath.section == ChatListSectionActions) {
        void (^action)(void) = self.onNewChat;
        [self closeThen:action];
    } else if (indexPath.section == ChatListSectionMore) {
        void (^action)(void) = self.onShowClaudeMenu;
        [self closeThen:action];
    } else if ((NSUInteger)indexPath.row < _shown.count) {
        NSString *chatID = _shown[(NSUInteger)indexPath.row][@"id"];
        void (^open)(NSString *) = self.onOpenChat;
        [self closeThen:^{
            if (open) {
                open(chatID);
            }
        }];
    }
}

@end
