// Optional UI patch of the plugin payload (signed together with the code). Empty on purpose:
// the shell page (src/plugin/templates/ui.html) is complete. A patch runs as the body of
// `new Function('shell', <this file>)` and may replace the functions named in PATCHABLE
// (loader-ui.js) with shell.define(name, fn); shell.orig holds the pristine functions.
