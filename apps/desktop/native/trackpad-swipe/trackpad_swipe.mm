#import <AppKit/AppKit.h>
#include <node_api.h>

namespace {

enum class Phase { Begin, Update, End, Cancel };

struct Payload {
  Phase phase;
  double x;
  double y;
  double dx;
  double dy;
};

void CallJs(napi_env env, napi_value callback, void*, void* data) {
  Payload* p = static_cast<Payload*>(data);
  if (env != nullptr && callback != nullptr) {
    static const char* names[] = {"begin", "update", "end", "cancel"};
    napi_value event, phase, num, undefined;
    napi_create_object(env, &event);
    napi_create_string_utf8(env, names[static_cast<int>(p->phase)], NAPI_AUTO_LENGTH, &phase);
    napi_set_named_property(env, event, "phase", phase);
    if (p->phase == Phase::Begin) {
      napi_create_double(env, p->x, &num);
      napi_set_named_property(env, event, "x", num);
      napi_create_double(env, p->y, &num);
      napi_set_named_property(env, event, "y", num);
    }
    if (p->phase == Phase::Begin || p->phase == Phase::Update) {
      napi_create_double(env, p->dx, &num);
      napi_set_named_property(env, event, "dx", num);
      napi_create_double(env, p->dy, &num);
      napi_set_named_property(env, event, "dy", num);
    }
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, callback, 1, &event, nullptr);
  }
  delete p;
}

}  // namespace

@interface PlanSwipeWatcher : NSObject
@property(nonatomic, weak) NSView* view;
@property(nonatomic, strong) id monitor;
@property(nonatomic) napi_threadsafe_function tsfn;
@property(nonatomic) BOOL inGesture;
- (void)handle:(NSEvent*)event;
@end

@implementation PlanSwipeWatcher

- (void)emit:(Phase)phase x:(double)x y:(double)y dx:(double)dx dy:(double)dy {
  Payload* p = new Payload{phase, x, y, dx, dy};
  if (napi_call_threadsafe_function(self.tsfn, p, napi_tsfn_nonblocking) != napi_ok) delete p;
}

// Deltas leave here in DOM wheel convention (positive = scroll right/down),
// the inverse of AppKit's scrollingDelta (positive = content moves right/down).
- (void)handle:(NSEvent*)event {
  NSView* view = self.view;
  if (view == nil || event.window != view.window) return;
  switch (event.phase) {
    case NSEventPhaseBegan: {
      self.inGesture = NO;
      if (!event.hasPreciseScrollingDeltas || ![NSEvent isSwipeTrackingFromScrollEventsEnabled]) return;
      self.inGesture = YES;
      NSPoint p = [view convertPoint:event.locationInWindow fromView:nil];
      double y = view.isFlipped ? p.y : view.bounds.size.height - p.y;
      [self emit:Phase::Begin x:p.x y:y dx:-event.scrollingDeltaX dy:-event.scrollingDeltaY];
      return;
    }
    case NSEventPhaseChanged:
      if (self.inGesture)
        [self emit:Phase::Update x:0 y:0 dx:-event.scrollingDeltaX dy:-event.scrollingDeltaY];
      return;
    case NSEventPhaseEnded:
      if (self.inGesture) [self emit:Phase::End x:0 y:0 dx:0 dy:0];
      self.inGesture = NO;
      return;
    case NSEventPhaseCancelled:
      if (self.inGesture) [self emit:Phase::Cancel x:0 y:0 dx:0 dy:0];
      self.inGesture = NO;
      return;
    default:
      return;
  }
}

@end

namespace {

NSMutableDictionary<NSNumber*, PlanSwipeWatcher*>* watchers;
int32_t nextId = 1;

napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

// start(nativeWindowHandle: Buffer, callback: (event) => void): number
napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) return Throw(env, "start(handle, callback) expects 2 arguments");

  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void*))
    return Throw(env, "handle must be the Buffer from getNativeWindowHandle()");
  NSView* view = (__bridge NSView*)(*static_cast<void**>(data));

  napi_value name;
  napi_create_string_utf8(env, "trackpadSwipe", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn;
  if (napi_create_threadsafe_function(env, argv[1], nullptr, name, 0, 1, nullptr, nullptr,
                                      nullptr, CallJs, &tsfn) != napi_ok)
    return Throw(env, "callback must be a function");
  napi_unref_threadsafe_function(env, tsfn);

  PlanSwipeWatcher* watcher = [PlanSwipeWatcher new];
  watcher.view = view;
  watcher.tsfn = tsfn;
  __weak PlanSwipeWatcher* weakWatcher = watcher;
  watcher.monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                                          handler:^NSEvent*(NSEvent* event) {
                                                            [weakWatcher handle:event];
                                                            return event;
                                                          }];

  if (watchers == nil) watchers = [NSMutableDictionary new];
  int32_t id = nextId++;
  watchers[@(id)] = watcher;

  napi_value result;
  napi_create_int32(env, id, &result);
  return result;
}

// stop(id: number): void
napi_value Stop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int32_t id = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &id) != napi_ok)
    return Throw(env, "stop(id) expects the number start() returned");
  PlanSwipeWatcher* watcher = watchers[@(id)];
  if (watcher == nil) return nullptr;
  [NSEvent removeMonitor:watcher.monitor];
  watcher.monitor = nil;
  napi_release_threadsafe_function(watcher.tsfn, napi_tsfn_abort);
  [watchers removeObjectForKey:@(id)];
  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
