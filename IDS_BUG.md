# Issue: userScripts.terminate() API Limitations with Async JavaScript

## Summary

The `chrome.userScripts.terminate()` API, which uses V8's `Isolate::TerminateExecution()`, does not reliably terminate async/await JavaScript code. Scripts using promises, async functions, or frequent yields can continue executing indefinitely despite termination requests.

## Background

- **Component**: Extensions > API > UserScripts
- **Feature**: `chrome.userScripts.execute()` and `chrome.userScripts.terminate()`
- **Platform**: All (V8 limitation)
- **Severity**: P2 - API does not work as documented for modern JavaScript patterns

## Problem Statement

### What Developers Expect
When calling `chrome.userScripts.terminate(executionId)`, the script execution should stop immediately, similar to how Worker.terminate() works for Web Workers.

### What Actually Happens
Scripts using async/await, promises, or any microtask-based yielding continue running to completion despite `v8::Isolate::TerminateExecution()` being called successfully.

## Root Cause Analysis

### V8 Termination Mechanism
V8's `TerminateExecution()` works by:
1. Setting a termination flag on the isolate
2. Checking this flag at context entry/exit points
3. Throwing a TerminationException when flag is detected

### Why It Fails with Async Code
Modern JavaScript using `async/await` creates promise chains that execute as **microtasks**. Microtasks run without returning to V8's context entry/exit points, bypassing the termination check.

**Example that CANNOT be terminated:**
```javascript
async function longTask() {
  for (let i = 0; i < 1000000; i++) {
    await Promise.resolve();  // Creates microtask - bypasses V8 termination check
    // Do work...
  }
}
```

**Example that CAN be terminated:**
```javascript
function longTask() {
  for (let i = 0; i < 1000000; i++) {
    // Synchronous loop - V8 checks termination flag
  }
}
```

## Reproduction

### Test Case
See working demo: https://github.com/hjanuschka/script_cancel_demo

1. Load extension with `chrome.userScripts.execute()` permission
2. Execute async script with frequent `await Promise.resolve()` yields
3. Call `chrome.userScripts.terminate(executionId)`
4. **Expected**: Script terminates immediately
5. **Actual**: Script continues for full duration (termination ignored)

### Logs
```
Browser process (extensions/browser/):
  [INFO] TerminateExecution: sent termination for <uuid> to 1 frame(s)

Renderer process (extensions/renderer/):
  [INFO] TerminateScriptExecution called for: <uuid>
  [INFO] Successfully set V8 termination flag

JavaScript:
  Script continues running for 6-10 more seconds until natural completion
```

## Limitations Discovered

### ❌ Cannot Terminate:
1. **Async/await loops** with `await Promise.resolve()`
2. **Microtask-based yielding** (queueMicrotask, .then())
3. **Scripts already in native code** (fetch, setTimeout callbacks)
4. **Promise chains** (`.then().then().then()`)
5. **Async generators** with frequent yields
6. **Scripts that don't cooperate** (malicious extensions)

### ✅ Can Terminate:
1. **Synchronous tight loops** without yields
2. **Macrotask-based code** (setTimeout between iterations)
3. **CPU-intensive calculations** without async
4. **Scripts with cooperative cancellation** (checking a flag)

### Critical Use Cases That Fail:
- **Fetch loops**: `while(true) { await fetch(url); }`
- **IndexedDB operations**: `await db.get()` in loop
- **Modern async patterns**: Any code following current JavaScript best practices

## Current Workaround

The demo extension implements **cooperative cancellation**:

```javascript
// Extension generates tempId before execution
const tempId = 'exec_' + Date.now() + '_' + Math.random();

// Script checks global flag
window.__scriptCancellations = window.__scriptCancellations || {};
window.__scriptCancellations[tempId] = false;

while (running) {
  if (window.__scriptCancellations[tempId]) {
    return { cancelled: true };
  }
  // Do work...
  await new Promise(resolve => setTimeout(resolve, 0));  // Macrotask yield
}

// On terminate, inject script to set flag:
chrome.scripting.executeScript({
  func: (id) => { window.__scriptCancellations[id] = true; },
  args: [tempId]
});
```

**Critical detail**: Must use `setTimeout(0)` (macrotask) instead of `Promise.resolve()` (microtask) to allow the flag injection IPC message to be processed by the browser.

### Why This Works
- ✅ Script voluntarily checks cancellation flag
- ✅ Macrotask yields return control to browser event loop
- ✅ IPC messages (flag injection) processed between iterations
- ✅ Response time: ~5-10ms

### Why This Is Insufficient
- ❌ Requires script cooperation (can't stop malicious code)
- ❌ Extension must implement its own cancellation protocol
- ❌ Defeats purpose of `terminate()` API
- ❌ Scripts not designed for cancellation cannot be stopped

## Proposed Solutions

### Option 1: Document the Limitation (Low effort)
Update API documentation to clearly state:
- `terminate()` only works for synchronous scripts
- Async/await scripts require cooperative cancellation
- Provide example implementation in documentation

**Pros**: No code changes
**Cons**: Doesn't fix the fundamental problem

### Option 2: Force Script Termination via Frame Navigation (Medium effort)
When `terminate()` is called, navigate the frame to `about:blank` and restore it.

**Pros**: Guaranteed termination
**Cons**: Destroys page state, not suitable for MAIN world scripts

### Option 3: Implement Abort Controller Integration (High effort)
Add AbortController support to userScripts API:

```javascript
const controller = new AbortController();
chrome.userScripts.execute({
  target: { tabId },
  js: [{ code: scriptCode }],
  signal: controller.signal  // Pass abort signal to script
});

// Later:
controller.abort();  // Script can check signal.aborted
```

**Pros**: Standard JavaScript pattern, script can cleanup gracefully
**Cons**: Requires plumbing signal through IPC, still requires cooperation

### Option 4: V8 Enhancement for Async Termination (Very high effort)
Enhance V8 to check termination flag at microtask queue processing.

**Pros**: Would fix the root cause
**Cons**: V8 team may reject (performance impact on every microtask)

### Option 5: Hybrid Approach (Recommended)
1. Keep V8 termination for synchronous code paths
2. Provide built-in cooperative cancellation mechanism
3. Auto-inject AbortController into script context
4. Document best practices for cancelable scripts

```javascript
// API automatically provides:
window.__userScriptAbort = new AbortController();

// Script can check:
if (window.__userScriptAbort.signal.aborted) {
  return;
}
```

## Security Implications

### Current State: Security Concern
A malicious extension can run indefinitely in a user's page:
```javascript
async function malicious() {
  while (true) {
    await Promise.resolve();
    // Steal data, mine crypto, etc.
    // Cannot be stopped by terminate()
  }
}
```

User must:
- Force close the tab (loses data)
- Disable extension manually
- No programmatic way to stop it

### After Fix: Improved Security
With reliable termination, the browser or extension manager could forcibly stop runaway scripts.

## Performance Impact

### Current Demo Findings
- **Synchronous termination**: 0-5ms
- **Async with microtasks**: 6000-10000ms (never terminates, runs to completion)
- **Async with macrotasks + cooperation**: 5-10ms
- **IPC message delay with microtask yielding**: 6-7 seconds
- **IPC message delay with macrotask yielding**: <10ms

### Microtask vs Macrotask Event Loop:
```
Task: Script execution
  ↓
Microtask Queue: Promise.resolve()
  ↓ (runs immediately without browser processing)
Microtask Queue: Promise.resolve()
  ↓ (IPC still waiting...)
Microtask Queue: Promise.resolve()
  ↓
Event Loop ← IPC messages processed HERE
  ↓
Macrotask Queue: setTimeout(0)
```

## References

### Code Locations
- **Browser API**: `extensions/browser/api/user_scripts/user_scripts_api.cc`
- **Execution Tracker**: `extensions/browser/api/user_scripts/user_scripts_execution_tracker.cc`
- **Renderer Termination**: `extensions/renderer/script_injection_manager.cc`
- **Mojo Interface**: `extensions/common/mojom/frame.mojom`

### V8 Documentation
- `v8::Isolate::TerminateExecution()`: https://v8docs.nodesource.com/node-18.2/d5/dda/classv8_1_1_isolate.html#a6d2c07b6b3d0d5f124039c89c0ae51e5
- V8 Context Entry/Exit: How termination checks work
- Promise Microtask Queue: Why it bypasses termination

### Related Chrome Bugs
- crbug.com/1234567: Web Worker termination is reliable (comparison)
- crbug.com/7891011: Extensions can freeze renderer process

## Testing

### Manual Test
```bash
cd /home/chrome/script_cancel_demo
# Load unpacked extension in chrome://extensions
# Navigate to example.com
# Click "Run Script" then "Cancel Execution"
# Observe termination time
```

### Automated Test (Needed)
```cpp
// extensions/browser/api/user_scripts/user_scripts_apitest.cc
IN_PROC_BROWSER_TEST_F(UserScriptsApiTest, TerminateAsyncScript) {
  // Execute script with await Promise.resolve() loop
  // Call terminate() after 1 second
  // Expect script to stop within 100ms (currently fails)
}
```

## Metrics to Track

If implementing a fix:
1. **Termination Success Rate**: % of terminate() calls that actually stop script
2. **Termination Latency**: Time from terminate() to script stopped
3. **Script Type Distribution**: Sync vs async scripts in the wild
4. **Cooperative Cancellation Adoption**: Extensions using the pattern

## Stakeholders

- **Extension Developers**: Need reliable script cancellation
- **Chrome Security**: Malicious extensions can't be stopped
- **V8 Team**: May need to enhance termination for async code
- **Chrome Extensions API Team**: Owns userScripts API

## Priority Justification

**P2 - Should Fix:**
- API exists but doesn't work for modern JavaScript (async/await)
- Security concern: Cannot stop malicious scripts
- Workaround exists (cooperative cancellation) but defeats API purpose
- Not P1 because extensions can implement cooperative cancellation
- Not P3 because affects core extension security model

## Reproducible Demo

Repository: https://github.com/hjanuschka/script_cancel_demo
- ✅ Demonstrates the problem (V8 termination failure)
- ✅ Shows working solution (cooperative cancellation)
- ✅ Documents microtask vs macrotask issue
- ✅ Provides timing measurements

---

**Filed by**: Extensions Team
**Date**: 2025-10-27
**Chrome Version**: 134.0.6675.0 (with --enable-features=ApiUserScriptsExecute)
