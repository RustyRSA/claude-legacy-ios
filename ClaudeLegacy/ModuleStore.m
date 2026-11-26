//
//  ModuleStore.m
//  ClaudeLegacy
//
//

#import <CommonCrypto/CommonDigest.h>
#import "ModuleStore.h"
#import "AppShared.h"

@implementation ModuleStore {
    dispatch_queue_t _queue;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        // Reads run side by side; writes and pruning run alone.
        _queue = dispatch_queue_create("ClaudeLegacy.moduleStore", DISPATCH_QUEUE_CONCURRENT);
    }
    return self;
}

+ (NSURL *)rootURL {
    NSURL *caches = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                          inDomains:NSUserDomainMask] firstObject];
    return [caches URLByAppendingPathComponent:@"transpiled-modules" isDirectory:YES];
}

/// The folder for one transpiler version, or nil for a name that is not plain.
+ (NSURL *)folderNamed:(id)name {
    if (![name isKindOfClass:NSString.class]) {
        return nil;
    }
    NSString *text = name;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
                               @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"];
    if (text.length == 0 || text.length > 64 || [text hasPrefix:@"."]
        || [text rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) {
        return nil;
    }
    return [[self rootURL] URLByAppendingPathComponent:text isDirectory:YES];
}

/// The file name for a module address, or nil if it is not an https address.
+ (NSString *)fileNameForKey:(id)key {
    if (![key isKindOfClass:NSString.class]) {
        return nil;
    }
    NSString *text = key;
    if (![text hasPrefix:@"https://"] || text.length > 2048) {
        return nil;
    }
    NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *fileName = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2 + 3];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        [fileName appendFormat:@"%02x", digest[i]];
    }
    [fileName appendString:@".js"];
    return fileName;
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id _Nullable reply, NSString * _Nullable errorMessage))replyHandler
{
    if (!IsTrustedFrame(message.frameInfo) || ![message.body isKindOfClass:NSDictionary.class]) {
        replyHandler(nil, @"refused");
        return;
    }
    NSDictionary *body = message.body;
    NSString *op = [body[@"op"] isKindOfClass:NSString.class] ? body[@"op"] : @"";
    NSURL *folder = [ModuleStore folderNamed:body[@"dir"]];
    if (folder == nil) {
        replyHandler(nil, @"bad folder name");
        return;
    }
    void (^reply)(id, NSString *) = ^(id value, NSString *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            replyHandler(value, error);
        });
    };

    if ([op isEqualToString:@"get"]) {
        NSArray *keys = [body[@"keys"] isKindOfClass:NSArray.class] ? body[@"keys"] : @[];
        dispatch_async(_queue, ^{
            NSMutableArray *codes = [NSMutableArray arrayWithCapacity:keys.count];
            for (id key in keys) {
                NSString *fileName = [ModuleStore fileNameForKey:key];
                NSString *code = nil;
                if (fileName) {
                    code = [NSString stringWithContentsOfURL:[folder URLByAppendingPathComponent:fileName]
                                                    encoding:NSUTF8StringEncoding
                                                       error:nil];
                }
                [codes addObject:code ? (id)code : (id)[NSNull null]];
            }
            reply(codes, nil);
        });
        return;
    }

    if ([op isEqualToString:@"put"]) {
        NSString *fileName = [ModuleStore fileNameForKey:body[@"key"]];
        id code = body[@"code"];
        if (fileName == nil || ![code isKindOfClass:NSString.class]) {
            replyHandler(nil, @"bad module");
            return;
        }
        dispatch_barrier_async(_queue, ^{
            NSError *error = nil;
            [NSFileManager.defaultManager createDirectoryAtURL:folder withIntermediateDirectories:YES attributes:nil error:nil];
            BOOL ok = [(NSString *)code writeToURL:[folder URLByAppendingPathComponent:fileName]
                                        atomically:YES
                                          encoding:NSUTF8StringEncoding
                                             error:&error];
            reply(@(ok), ok ? nil : (error.localizedDescription ?: @"write failed"));
        });
        return;
    }

    if ([op isEqualToString:@"prune"]) {
        NSArray *keep = [body[@"keep"] isKindOfClass:NSArray.class] ? body[@"keep"] : @[];
        if (keep.count == 0) {
            replyHandler(nil, @"empty keep list");
            return;
        }
        dispatch_barrier_async(_queue, ^{
            NSFileManager *files = NSFileManager.defaultManager;
            NSMutableSet *keepNames = [NSMutableSet setWithCapacity:keep.count];
            for (id key in keep) {
                NSString *fileName = [ModuleStore fileNameForKey:key];
                if (fileName) {
                    [keepNames addObject:fileName];
                }
            }
            // Folders of other transpiler versions go entirely.
            NSArray<NSURL *> *folders = [files contentsOfDirectoryAtURL:[ModuleStore rootURL]
                                             includingPropertiesForKeys:nil
                                                                options:0
                                                                  error:nil];
            for (NSURL *other in folders) {
                if (![other.lastPathComponent isEqualToString:folder.lastPathComponent]) {
                    [files removeItemAtURL:other error:nil];
                }
            }
            NSInteger removed = 0;
            NSInteger count = 0;
            long long bytes = 0;
            NSArray<NSURL *> *entries = [files contentsOfDirectoryAtURL:folder
                                             includingPropertiesForKeys:@[NSURLFileSizeKey]
                                                                options:0
                                                                  error:nil];
            for (NSURL *entry in entries) {
                if (![keepNames containsObject:entry.lastPathComponent]) {
                    if ([files removeItemAtURL:entry error:nil]) {
                        removed += 1;
                    }
                    continue;
                }
                id size = nil;
                [entry getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
                count += 1;
                if ([size isKindOfClass:NSNumber.class]) {
                    bytes += [(NSNumber *)size longLongValue];
                }
            }
            reply(@{@"removed": @(removed), @"files": @(count), @"bytes": @(bytes)}, nil);
        });
        return;
    }

    replyHandler(nil, @"unknown operation");
}

@end
