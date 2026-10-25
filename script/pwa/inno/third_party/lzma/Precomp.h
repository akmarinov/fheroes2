/* Minimal stand-in for the 7-Zip SDK C/Precomp.h, which only matters on Windows:
   it includes Compiler.h and then sets Win32 version macros. The LZMA decoders need
   nothing from it on wasm, and dropping the Win32 half keeps the vendored set to the
   decoder sources themselves. */
#ifndef FH2_LZMA_PRECOMP_H
#define FH2_LZMA_PRECOMP_H
#include "Compiler.h"
#endif
