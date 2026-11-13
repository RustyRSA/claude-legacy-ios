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
static NSArray<NSDictionary *> *gGroups = nil;

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

+ (NSString *)cleanName:(id)value limit:(NSUInteger)limit {
    NSString *name = [value isKindOfClass:NSString.class] ? value : @"";
    name = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return name.length > limit ? [name substringToIndex:limit] : name;
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
    NSString *name = [self cleanName:source[@"name"] limit:200];
    NSNumber *updated = [source[@"updated"] isKindOfClass:NSNumber.class] ? source[@"updated"] : @0;
    NSDate *seenAt = [source[@"seen"] isKindOfClass:NSDate.class] ? source[@"seen"] : seen;
    return @{@"id": [(NSString *)chatID lowercaseString],
             @"name": name.length ? name : @"Untitled",
             @"updated": @(MAX(updated.doubleValue, 0)),
             @"seen": seenAt};
}

/// Sections in the stored shape: {name, chats: [{id, name}]}; anything else is left out.
+ (NSArray<NSDictionary *> *)groupsFrom:(id)value {
    NSMutableArray<NSDictionary *> *groups = [NSMutableArray array];
    if (![value isKindOfClass:NSArray.class]) {
        return groups;
    }
    for (id item in (NSArray *)value) {
        if (![item isKindOfClass:NSDictionary.class] || groups.count >= 40) {
            continue;
        }
        NSDictionary *source = item;
        NSMutableArray<NSDictionary *> *chats = [NSMutableArray array];
        id list = source[@"chats"];
        if ([list isKindOfClass:NSArray.class]) {
            for (id chat in (NSArray *)list) {
                if (![chat isKindOfClass:NSDictionary.class] || ![self isChatID:((NSDictionary *)chat)[@"id"]]) {
                    continue;
                }
                NSString *name = [self cleanName:((NSDictionary *)chat)[@"name"] limit:200];
                [chats addObject:@{@"id": [(NSString *)((NSDictionary *)chat)[@"id"] lowercaseString],
                                   @"name": name.length ? name : @"Untitled"}];
            }
        }
        if (chats.count) {
            [groups addObject:@{@"name": [self cleanName:source[@"name"] limit:60], @"chats": chats}];
        }
    }
    return groups;
}

+ (void)loadIfNeeded {
    if (gChats != nil) {
        return;
    }
    gChats = [NSMutableArray array];
    gGroups = @[];
    NSData *data = [NSData dataWithContentsOfURL:[self fileURL]];
    id plist = data ? [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:nil] : nil;
    // Round 13c wrote a plain list of chats; since 14 a dictionary with sections.
    id chats = plist;
    if ([plist isKindOfClass:NSDictionary.class]) {
        chats = ((NSDictionary *)plist)[@"chats"];
        gGroups = [self groupsFrom:((NSDictionary *)plist)[@"groups"]];
    }
    if (![chats isKindOfClass:NSArray.class]) {
        return;
    }
    NSDate *now = [NSDate date];
    for (id item in (NSArray *)chats) {
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

+ (NSArray<NSDictionary *> *)groups {
    [self loadIfNeeded];
    return gGroups;
}

+ (void)setGroups:(NSArray *)groups {
    [self loadIfNeeded];
    NSArray<NSDictionary *> *clean = [self groupsFrom:groups];
    if (clean.count == 0) {
        return;
    }
    gGroups = clean;
    // The chats in the sections are known chats too (kept, and searchable).
    NSMutableArray *all = [NSMutableArray array];
    for (NSDictionary *group in clean) {
        [all addObjectsFromArray:group[@"chats"]];
    }
    [self mergeChats:all force:YES];
}

+ (void)mergeChats:(NSArray *)items {
    [self mergeChats:items force:NO];
}

+ (void)mergeChats:(NSArray *)items force:(BOOL)force {
    if (![items isKindOfClass:NSArray.class] || items.count == 0) {
        return;
    }
    [self loadIfNeeded];
    NSDate *now = [NSDate date];
    NSMutableDictionary<NSString *, NSNumber *> *indexByID = [NSMutableDictionary dictionary];
    [gChats enumerateObjectsUsingBlock:^(NSDictionary *chat, NSUInteger index, BOOL *stop) {
        indexByID[chat[@"id"]] = @(index);
    }];
    BOOL changed = force;
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

/// Written at most every minute (the "seen" times change at every report), at
/// once when a name, time, the set of chats or the sections changed.
+ (void)saveSoon:(BOOL)changed {
    static NSDate *lastSave = nil;
    if (!changed && lastSave != nil && -[lastSave timeIntervalSinceNow] < 60) {
        return;
    }
    lastSave = [NSDate date];
    NSDictionary *snapshot = @{@"chats": [gChats copy], @"groups": gGroups ?: @[]};
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

@implementation ChatListViewController {
    /// What the table shows: {title (NSString), kind ("actions", "chats", "more"), chats (NSArray)}.
    NSArray<NSDictionary *> *_sections;
    NSArray<NSDictionary *> *_browse;
    NSArray<NSDictionary *> *_everyChat;
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

    [self buildSections];
    _sections = _browse;
}

/// New chat; then the sections of claude.ai's sidebar in its order (Starred, your
/// groups, Recents), then the chats that are in none of them; then the menus.
- (void)buildSections {
    NSArray<NSDictionary *> *chats = [ChatListStore chats];
    NSMutableDictionary<NSString *, NSDictionary *> *byID = [NSMutableDictionary dictionary];
    for (NSDictionary *chat in chats) {
        byID[chat[@"id"]] = chat;
    }
    NSMutableArray<NSDictionary *> *sections = [NSMutableArray array];
    [sections addObject:@{@"kind": @"actions", @"title": @"", @"chats": @[]}];

    NSMutableSet<NSString *> *placed = [NSMutableSet set];
    NSMutableArray<NSDictionary *> *every = [NSMutableArray array];
    for (NSDictionary *group in [ChatListStore groups]) {
        NSMutableArray<NSDictionary *> *rows = [NSMutableArray array];
        for (NSDictionary *item in group[@"chats"]) {
            NSString *chatID = item[@"id"];
            NSDictionary *known = byID[chatID];
            NSDictionary *row = @{@"id": chatID, @"name": item[@"name"], @"updated": known[@"updated"] ?: @0};
            [rows addObject:row];
            if (![placed containsObject:chatID]) {
                [placed addObject:chatID];
                [every addObject:row];
            }
        }
        NSString *title = [group[@"name"] length] ? group[@"name"] : @"Chats";
        [sections addObject:@{@"kind": @"chats", @"title": title, @"chats": rows}];
    }
    NSMutableArray<NSDictionary *> *rest = [NSMutableArray array];
    for (NSDictionary *chat in chats) {
        if (![placed containsObject:chat[@"id"]]) {
            [rest addObject:chat];
            [every addObject:chat];
        }
    }
    if (rest.count || placed.count == 0) {
        [sections addObject:@{@"kind": @"chats", @"title": placed.count ? @"Other chats" : @"", @"chats": rest}];
    }
    [sections addObject:@{@"kind": @"more", @"title": @"", @"chats": @[]}];
    _browse = sections;
    _everyChat = every;
}

- (void)close {
    [self.presentingViewController dismissViewControllerAnimated:YES completion:nil];
}

/// A chat or New chat: the page starts on it at once while the list slides away.
- (void)runAndClose:(void (^)(void))action {
    if (action) {
        action();
    }
    UIViewController *presenter = self.navigationController.presentingViewController ?: self.presentingViewController;
    [presenter dismissViewControllerAnimated:YES completion:nil];
}

/// A menu: the list goes without animation so the menu opens straight away.
- (void)closeThen:(void (^)(void))action {
    UIViewController *presenter = self.navigationController.presentingViewController ?: self.presentingViewController;
    [presenter dismissViewControllerAnimated:NO completion:^{
        if (action) {
            action();
        }
    }];
}

- (void)updateSearchResultsForSearchController:(UISearchController *)searchController {
    NSString *query = [searchController.searchBar.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    _searching = query.length > 0;
    if (!_searching) {
        _sections = _browse;
    } else {
        NSStringCompareOptions options = NSCaseInsensitiveSearch | NSDiacriticInsensitiveSearch;
        NSArray *hits = [_everyChat filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *chat, NSDictionary *bindings) {
            return [(NSString *)chat[@"name"] rangeOfString:query options:options].location != NSNotFound;
        }]];
        _sections = @[@{@"kind": @"chats", @"title": @"", @"chats": hits}];
    }
    [self.tableView reloadData];
}

#pragma mark Table

- (NSDictionary *)sectionAt:(NSInteger)section {
    return _sections[(NSUInteger)section];
}

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
    return (NSInteger)_sections.count;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
    NSDictionary *info = [self sectionAt:section];
    NSString *kind = info[@"kind"];
    if ([kind isEqualToString:@"actions"]) {
        return 1;
    }
    if ([kind isEqualToString:@"more"]) {
        return 2;
    }
    return (NSInteger)[info[@"chats"] count];
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
    NSString *title = [self sectionAt:section][@"title"];
    return title.length ? title : nil;
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
    NSDictionary *info = [self sectionAt:section];
    NSString *kind = info[@"kind"];
    if ([kind isEqualToString:@"chats"] && [info[@"chats"] count] == 0 && [info[@"title"] length] == 0) {
        return _searching ? @"No chat with that name in the list on this phone." : @"Chats appear here once Claude has listed them.";
    }
    if ([kind isEqualToString:@"more"]) {
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

    NSDictionary *info = [self sectionAt:indexPath.section];
    NSString *kind = info[@"kind"];
    if ([kind isEqualToString:@"actions"]) {
        cell.textLabel.text = @"New chat";
        cell.textLabel.textColor = self.view.tintColor;
        cell.imageView.image = [UIImage systemImageNamed:@"square.and.pencil"];
    } else if ([kind isEqualToString:@"more"]) {
        BOOL appRow = indexPath.row == 1;
        cell.textLabel.text = appRow ? @"App settings" : @"Claude menu";
        cell.imageView.image = [UIImage systemImageNamed:appRow ? @"gearshape" : @"sidebar.left"];
        cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    } else {
        NSArray<NSDictionary *> *chats = info[@"chats"];
        NSDictionary *chat = (NSUInteger)indexPath.row < chats.count ? chats[(NSUInteger)indexPath.row] : nil;
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
    NSDictionary *info = [self sectionAt:indexPath.section];
    NSString *kind = info[@"kind"];
    if ([kind isEqualToString:@"actions"]) {
        [self runAndClose:self.onNewChat];
    } else if ([kind isEqualToString:@"more"]) {
        [self closeThen:indexPath.row == 1 ? self.onShowAppMenu : self.onShowClaudeMenu];
    } else {
        NSArray<NSDictionary *> *chats = info[@"chats"];
        if ((NSUInteger)indexPath.row >= chats.count) {
            return;
        }
        NSString *chatID = chats[(NSUInteger)indexPath.row][@"id"];
        void (^open)(NSString *) = self.onOpenChat;
        [self runAndClose:^{
            if (open) {
                open(chatID);
            }
        }];
    }
}

@end
