#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

extern int SLSMainConnectionID(void);
extern uint64_t SLSGetActiveSpace(int cid);
extern CFArrayRef SLSCopyManagedDisplaySpaces(int cid);

static id jsonSafe(id value) {
    if (!value || value == [NSNull null]) return [NSNull null];

    if ([value isKindOfClass:[NSString class]] ||
        [value isKindOfClass:[NSNumber class]]) {
        return value;
    }

    if ([value isKindOfClass:[NSArray class]]) {
        NSMutableArray *out = [NSMutableArray array];
        for (id item in (NSArray *)value) {
            [out addObject:jsonSafe(item)];
        }
        return out;
    }

    if ([value isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *out = [NSMutableDictionary dictionary];
        [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id key, id obj, BOOL *stop) {
            out[[key description]] = jsonSafe(obj);
        }];
        return out;
    }

    return [value description];
}

static int printJSON(id object) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:jsonSafe(object)
                                                   options:0
                                                     error:&error];
    if (!data) {
        fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
        return 2;
    }

    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    return 0;
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        int cid = SLSMainConnectionID();
        NSString *cmd = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"active";

        if ([cmd isEqualToString:@"active"]) {
            uint64_t activeSpaceId = SLSGetActiveSpace(cid);
            if (activeSpaceId == 0) {
                fprintf(stderr, "SLSGetActiveSpace returned 0\n");
                return 2;
            }

            printf("%llu\n", (unsigned long long)activeSpaceId);
            return 0;
        }

        if ([cmd isEqualToString:@"dump"]) {
            CFArrayRef ref = SLSCopyManagedDisplaySpaces(cid);
            if (!ref) {
                fprintf(stderr, "SLSCopyManagedDisplaySpaces returned NULL\n");
                return 2;
            }

            uint64_t activeSpaceId = SLSGetActiveSpace(cid);
            if (activeSpaceId == 0) {
                CFRelease(ref);
                fprintf(stderr, "SLSGetActiveSpace returned 0\n");
                return 2;
            }

            NSArray *spaces = CFBridgingRelease(ref);
            NSDictionary *out = @{
                @"activeSpaceId": @(activeSpaceId),
                @"managedDisplaySpaces": spaces
            };

            return printJSON(out);
        }

        fprintf(stderr, "usage: spacectl active|dump\n");
        return 64;
    }
}
