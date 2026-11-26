//
//  ModuleStore.h
//  ClaudeLegacy
//
//  The app's store of transpiled claude.ai modules (round 7).
//

#import <WebKit/WebKit.h>

/// Transpiled claude.ai modules, kept as files in the app's Caches folder
/// instead of claude.ai's web storage (CacheStorage), whose quota they filled and
/// which took seconds to open at every launch. The page asks through the
/// "moduleStore" handler and gets an answer back (iOS 14 and later):
///   {op: "get", dir, keys: [address, ...]} -> [code or null, ...]
///   {op: "put", dir, key: address, code}   -> true
///   {op: "prune", dir, keep: [address, ...]} -> {removed, files, bytes}
/// dir names the transpiler version (one folder each; prune removes the
/// others). A file is named by the SHA-256 of its https address, so no
/// address can name a path. Only claude.ai's top-level page is answered.
API_AVAILABLE(ios(14.0))
@interface ModuleStore : NSObject <WKScriptMessageHandlerWithReply>
@end
