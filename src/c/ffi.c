#include <pebble.h>

// Expose the watch's Text Size preference to JavaScript. 0 = small,
// 1 = medium, 2 = large, 3 = extra large.
int32_t slide_content_size(void) {
  return (int32_t)preferred_content_size();
}
