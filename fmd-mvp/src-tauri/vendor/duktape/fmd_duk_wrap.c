#include "duktape.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Returns heap-allocated result string (caller frees with fmd_duk_free). On error returns NULL and fills err. */
char *fmd_duk_execjs(const char *src, size_t len, char *err, size_t err_len) {
	duk_context *ctx;
	const char *s;
	char *out;

	if (err && err_len) {
		err[0] = '\0';
	}
	ctx = duk_create_heap_default();
	if (!ctx) {
		if (err && err_len) {
			snprintf(err, err_len, "Failed to create a Duktape heap.");
		}
		return NULL;
	}
	duk_push_lstring(ctx, src, (duk_size_t)len);
	if (duk_peval(ctx) != 0) {
		if (err && err_len) {
			snprintf(err, err_len, "Duktape error: %s", duk_safe_to_string(ctx, -1));
		}
		duk_destroy_heap(ctx);
		return NULL;
	}
	s = duk_safe_to_string(ctx, -1);
	if (s && strcmp(s, "undefined") != 0) {
		out = (char *)malloc(strlen(s) + 1);
		if (out) {
			memcpy(out, s, strlen(s) + 1);
		}
	} else {
		out = (char *)malloc(1);
		if (out) {
			out[0] = '\0';
		}
	}
	duk_destroy_heap(ctx);
	return out;
}

void fmd_duk_free(char *p) {
	free(p);
}
