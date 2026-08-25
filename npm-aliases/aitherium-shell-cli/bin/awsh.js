#!/usr/bin/env node
// Alias shim. This package exists ONLY so another name keeps working; the real
// shell is the `awsh` dependency, so the two can never serve different behaviour.
import('awsh/dist/main.js');
