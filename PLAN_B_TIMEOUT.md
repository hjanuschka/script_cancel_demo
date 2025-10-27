# Plan B: Self-Terminating Timeout (Alternative to IPC Cancellation)

## The Problem This Solves

As documented in `LIMITATIONS.md`, IPC-based cancellation has a fundamental issue with async JavaScript:

```javascript
// IPC message to inject cancellation flag can be delayed 6+ seconds
async function loop() {
  while (true) {
    await Promise.resolve();  // Microtask - blocks IPC processing
    // Cancellation flag injection stuck in queue...
  }
}
```

Even with our cooperative cancellation approach using macrotasks, there's still a small delay (~5-10ms) for the IPC message to arrive and be processed.

## Plan B: Inject Timeout BEFORE Execution

If you know the timeout **before** the script starts, you can inject it into the script context. The script then self-terminates without needing any IPC messages during execution.

### How It Works

```javascript
// Extension code (background.js)
async function executeWithTimeout(duration, timeout) {
  const scriptCode = `
    (async function() {
      const startTime = Date.now();
      const duration = ${duration};
      const timeout = ${timeout};  // ← Injected before execution

      while (Date.now() - startTime < duration) {
        // Check timeout LOCALLY (no IPC needed)
        if (Date.now() - startTime >= timeout) {
          console.log('Self-terminated due to timeout');
          return { success: false, timeout: true };
        }

        // Do work...
        await Promise.resolve();  // Microtasks are OK!
      }
    })();
  `;

  await chrome.userScripts.execute({
    target: { tabId },
    js: [{ code: scriptCode }]
  });
}
```

### Key Advantages

✅ **No IPC Delay**
- Timeout value is already in script context
- No need to wait for browser→renderer IPC message
- Works even if microtasks block the event loop

✅ **Works With Any Async Pattern**
```javascript
// This works fine with timeout approach:
while (running) {
  await fetch(url);           // OK
  await Promise.resolve();    // OK
  await db.get();             // OK

  // Timeout check happens locally
  if (Date.now() - start >= timeout) {
    return { timeout: true };
  }
}
```

✅ **Deterministic Timing**
- Timeout is checked on every iteration
- Resolution: ~5ms (whatever your work burst is)
- No IPC jitter or delays

✅ **Still Uses Cooperative Cancellation**
- Script voluntarily checks timeout and exits
- Can cleanup resources properly
- Returns meaningful result (`{ timeout: true }`)

## Comparison: IPC Cancellation vs Self-Timeout

| Feature | IPC Cancellation | Self-Timeout |
|---------|------------------|--------------|
| **Can cancel dynamically** | ✅ Yes (user clicks button) | ❌ No (timeout set upfront) |
| **Works with microtasks** | ⚠️ Only with `setTimeout(0)` | ✅ Yes (any pattern) |
| **Latency** | 5-10ms | 0ms (local check) |
| **IPC messages** | 1 per cancel | 0 |
| **Requires cooperation** | ✅ Yes | ✅ Yes |
| **Browser process involved** | ✅ Yes (inject flag) | ❌ No (self-contained) |

## When to Use Each Approach

### Use IPC Cancellation When:
- User needs ability to cancel at any time
- Timeout is not known upfront
- Interactive scenarios (user clicks "Cancel")
- You can ensure macrotask yielding

### Use Self-Timeout When:
- Timeout is known before execution
- Script should automatically stop after N seconds
- Working with legacy async code (can't change yielding)
- Want guaranteed timeout (no IPC delays)
- Background tasks with max execution time

## Demo Implementation

The demo extension now has both approaches:

**Button 1: "Run Script" (IPC Cancellation)**
```
User clicks → Script runs → User clicks "Cancel" → IPC injected → Terminated
Timeline: Dynamic cancellation at any time
```

**Button 2: "Schedule 10s script with 5s timeout" (Self-Timeout)**
```
User clicks → Script runs with timeout → 5s passes → Self-terminates
Timeline: Predictable timeout, no user interaction needed
```

## Visual Indicators

The demo shows different colors for different exit conditions:

- 🟢 **Green**: Running with countdown
- 🔵 **Blue**: Completed successfully (ran full duration)
- 🔴 **Red**: Terminated (user clicked cancel, IPC-based)
- 🟠 **Orange**: Timeout (self-terminated, no IPC)

## Code Example: Production Usage

Here's how you might use this in a real extension:

```javascript
// Execute a data sync that should timeout after 30 seconds
async function syncData() {
  const scriptCode = `
    (async function() {
      const startTime = Date.now();
      const timeout = 30000;  // 30 seconds max

      window.__syncState = { cancelled: false };

      const items = await getItemsToSync();

      for (const item of items) {
        // Check timeout
        if (Date.now() - startTime >= timeout) {
          return {
            success: false,
            timeout: true,
            syncedCount: window.__syncState.syncedCount
          };
        }

        // Check if user cancelled
        if (window.__syncState.cancelled) {
          return {
            success: false,
            cancelled: true,
            syncedCount: window.__syncState.syncedCount
          };
        }

        // Do the work
        await syncItem(item);
        window.__syncState.syncedCount++;
      }

      return { success: true, syncedCount: items.length };
    })();
  `;

  const result = await chrome.userScripts.execute({
    target: { tabId },
    js: [{ code: scriptCode }],
    world: 'MAIN'
  });

  if (result.timeout) {
    console.log('Sync timed out after 30s, synced:', result.syncedCount);
  } else if (result.cancelled) {
    console.log('User cancelled sync, synced:', result.syncedCount);
  } else {
    console.log('Sync completed successfully!');
  }
}

// User can still cancel dynamically:
async function cancelSync() {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { window.__syncState.cancelled = true; },
    world: 'MAIN'
  });
}
```

This gives you **both** timeout safety AND user cancellation!

## Limitations

### ❌ Still Requires Cooperation
The script must:
1. Check the timeout condition
2. Voluntarily exit when timeout reached
3. Use proper yielding for responsive checks

Malicious scripts can still ignore timeout:
```javascript
// Malicious script that ignores timeout
while (true) {
  // Never checks timeout
  doEvilStuff();
  await Promise.resolve();
}
```

### ❌ Cannot Cancel Before Timeout
Once the timeout is set, you can't make it happen sooner (without also implementing IPC cancellation).

### ❌ Not True Termination
- Fetches in-flight will complete
- setTimeout callbacks already queued will fire
- Can't forcibly stop synchronous tight loops

## Best Practice: Use Both!

The best approach is to use **both** timeout AND cancellation:

```javascript
const scriptCode = `
  (async function() {
    const startTime = Date.now();
    const timeout = ${timeout};
    const tempId = '${tempId}';

    window.__scriptCancellations = window.__scriptCancellations || {};
    window.__scriptCancellations[tempId] = false;

    while (running) {
      // Check timeout FIRST (local, no IPC)
      if (timeout && Date.now() - startTime >= timeout) {
        return { success: false, timeout: true };
      }

      // Check cancellation SECOND (IPC-based, user control)
      if (window.__scriptCancellations[tempId]) {
        return { success: false, cancelled: true };
      }

      // Do work...
      await new Promise(r => setTimeout(r, 0));
    }
  })();
`;
```

This gives you:
- ✅ Safety: Script always stops after timeout
- ✅ Flexibility: User can cancel earlier if needed
- ✅ Best of both worlds

## Performance Characteristics

### Self-Timeout
```
Setup overhead: 0ms (value injected in string)
Check overhead: <1ms (simple timestamp comparison)
Termination latency: ~5ms (next check iteration)
IPC messages: 0
Browser process: Not involved in checking
```

### IPC Cancellation
```
Setup overhead: 10-20ms (generate tempId, setup flag)
Check overhead: <1ms (check global variable)
Termination latency: 5-10ms (IPC + next iteration)
IPC messages: 1 (flag injection)
Browser process: Must inject script via IPC
```

### Combined (Best Practice)
```
Setup overhead: 10-20ms (tempId + timeout value)
Check overhead: <2ms (two comparisons)
Timeout latency: ~5ms (local check)
Cancel latency: 5-10ms (IPC check)
IPC messages: 1 (only if user cancels)
Browser process: Only involved if user cancels
```

## Summary

**Plan A (IPC Cancellation)**: Full user control, requires macrotask yielding
**Plan B (Self-Timeout)**: Automatic safety, works with any async pattern
**Best**: Use both together for safety + flexibility

The demo extension showcases all three approaches:
1. Run Script (Plan A only - user control)
2. Schedule with timeout (Plan B only - automatic)
3. Combined approach (recommended for production)

Try the "Schedule 10s script with 5s timeout" button to see Plan B in action - it will always show an orange timeout after exactly 5 seconds, regardless of microtask/macrotask patterns!

---

See also:
- `LIMITATIONS.md` - What can and cannot be cancelled
- `IDS_BUG.md` - Full bug report on V8 termination issues
- `background.js` - Implementation of both approaches
