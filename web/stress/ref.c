/* Reads lines "algo v10 N r pers_hex|- header_hex" and prints the digest hex. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include "yespower.h"
void neoscrypt(const unsigned char *password, unsigned char *output, unsigned int profile);
static int unhex(const char *s, uint8_t *out, size_t max) {
  size_t n = strlen(s) / 2; if (n > max) return -1;
  for (size_t i = 0; i < n; i++) { unsigned v; sscanf(s + 2 * i, "%2x", &v); out[i] = v; }
  return (int)n;
}
int main(void) {
  char algo[16], pers[1024], hdr[200]; unsigned v10, N, r;
  while (scanf("%15s %u %u %u %1023s %199s", algo, &v10, &N, &r, pers, hdr) == 6) {
    uint8_t h[80], p[512], out[32]; int plen = -1;
    unhex(hdr, h, 80);
    if (strcmp(pers, "-")) plen = unhex(pers, p, sizeof p);
    if (!strcmp(algo, "yespower")) {
      yespower_params_t prm = { v10 ? YESPOWER_1_0 : YESPOWER_0_5, N, r, plen < 0 ? NULL : p, plen < 0 ? 0 : (size_t)plen };
      if (plen == 0) prm.pers = p; /* empty but present */
      if (yespower_tls(h, 80, &prm, (yespower_binary_t *)out)) { puts("FAILED"); continue; }
    } else if (!strcmp(algo, "neoscrypt")) {
      neoscrypt(h, out, 0);
    } else { puts("UNKNOWN"); continue; }
    for (int i = 0; i < 32; i++) printf("%02x", out[i]);
    putchar('\n');
  }
  return 0;
}
