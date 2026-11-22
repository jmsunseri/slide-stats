#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Piu plus the app modules need more than the default 32 kB engine pool.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 8192,
    .slot = 49152,
    .chunk = 32768,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug,
#endif
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
