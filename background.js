// Map to track active script executions
const activeExecutions = new Map();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'executeScript') {
    handleExecuteScript(message.duration, message.timeout).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'cancelScript') {
    handleCancelScript(message.executionId).then(sendResponse);
    return true;
  } else if (message.action === 'getActiveExecutions') {
    sendResponse(Array.from(activeExecutions.values()));
    return false;
  }
});

async function handleExecuteScript(duration, timeout) {
  try {
    // Check if userScripts API is available
    if (!chrome.userScripts || !chrome.userScripts.execute) {
      return {
        success: false,
        error: 'chrome.userScripts.execute API is not available. Make sure you:\n' +
               '1. Are running Chrome with --enable-features=ApiUserScriptsExecute\n' +
               '2. Are in Developer Mode (chrome://extensions)\n' +
               '3. Have rebuilt Chrome after the latest changes'
      };
    }

    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      return { success: false, error: 'No active tab found' };
    }

    // Generate a temporary ID for cooperative cancellation
    const tempId = 'exec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Execute a long-running script with cooperative cancellation
    const scriptCode = `
      (async function() {
        const startTime = Date.now();
        const duration = ${duration};
        const timeout = ${timeout || 'null'};  // Optional timeout
        const tempId = '${tempId}';

        console.log('Script started with temp ID: ' + tempId + ', duration: ' + duration + 'ms, timeout: ' + (timeout || 'none'));

        // Store cancellation flag globally
        window.__scriptCancellations = window.__scriptCancellations || {};
        window.__scriptCancellations[tempId] = false;

        // Create a visual indicator (top left so it's visible with popup)
        const indicator = document.createElement('div');
        indicator.id = 'script-cancel-demo-indicator';
        indicator.style.cssText = \`
          position: fixed;
          top: 10px;
          left: 10px;
          background: #4CAF50;
          color: white;
          padding: 15px;
          border-radius: 5px;
          z-index: 999999;
          font-family: Arial, sans-serif;
          font-size: 16px;
          font-weight: bold;
          box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        \`;
        indicator.textContent = 'Script starting...';
        document.body.appendChild(indicator);

        // Wait a moment to ensure indicator is visible before tight loop
        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate long-running work with UI updates
        let counter = 0;

        // Run until duration expires OR cancelled OR timeout
        while (Date.now() - startTime < duration) {
          const elapsed = Date.now() - startTime;

          // FIRST: Check timeout (self-termination without IPC)
          if (timeout !== null && elapsed >= timeout) {
            indicator.style.background = '#FF9800';
            indicator.style.fontSize = '18px';
            indicator.textContent = '⏱️ Script TIMEOUT (self-terminated)!';
            setTimeout(() => indicator.remove(), 5000);
            delete window.__scriptCancellations[tempId];
            console.log('Script self-terminated due to timeout after ' + elapsed + 'ms');
            return { success: false, timeout: true };
          }

          // SECOND: Check if cancelled (cooperative cancellation via IPC)
          if (window.__scriptCancellations[tempId]) {
            indicator.style.background = '#f44336';
            indicator.style.fontSize = '18px';
            indicator.textContent = '⛔ Script TERMINATED!';
            setTimeout(() => indicator.remove(), 5000);
            delete window.__scriptCancellations[tempId];
            console.log('Script terminated via IPC after ' + elapsed + 'ms');
            return { success: false, cancelled: true };
          }

          // Do a SHORT burst of work (5ms worth)
          const workUntil = Date.now() + 5;
          while (Date.now() < workUntil && !window.__scriptCancellations[tempId]) {
            counter++;
          }

          // Update UI
          const now = Date.now();
          const currentElapsed = now - startTime;
          const remaining = duration - currentElapsed;
          let statusText = '🟢 Running: ' + Math.round(remaining) + 'ms left';
          if (timeout !== null) {
            const timeoutRemaining = timeout - currentElapsed;
            statusText += ' (timeout in ' + Math.round(timeoutRemaining) + 'ms)';
          }
          indicator.textContent = statusText;

          // CRITICAL: Use setTimeout (macrotask) instead of Promise.resolve (microtask)
          // Microtasks run BEFORE the browser processes IPC messages
          // Macrotasks return to the event loop, allowing IPC to be processed
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Script completed successfully
        indicator.style.background = '#2196F3';
        indicator.textContent = 'Script completed successfully!';

        setTimeout(() => {
          indicator.remove();
        }, 2000);

        delete window.__scriptCancellations[tempId];
        return {
          success: true,
          iterations: counter
        };
      })();
    `;

    // Execute the script - returns executionId immediately
    const results = await chrome.userScripts.execute({
      target: { tabId: tab.id },
      js: [{ code: scriptCode }],  // Use js array with code property
      world: 'MAIN'
    });

    // Get the execution ID from the result
    const executionId = results[0]?.executionId;

    if (!executionId) {
      return {
        success: false,
        error: 'No execution ID returned by browser'
      };
    }

    console.log(`Script execution started with ID ${executionId}, tempId ${tempId}`);

    // Store execution info (including tempId for cooperative cancellation)
    activeExecutions.set(executionId, {
      executionId,
      tempId,  // Store for cooperative cancellation
      tabId: tab.id,
      startTime: Date.now(),
      duration,
      status: 'running'
    });

    // Monitor script completion in background
    setTimeout(() => {
      const execution = activeExecutions.get(executionId);
      if (execution && execution.status === 'running') {
        execution.status = 'completed';
        execution.endTime = Date.now();
      }
    }, duration + 1000);

    return {
      success: true,
      executionId
    };

  } catch (error) {
    console.error('Script execution failed:', error);

    return {
      success: false,
      error: error.message
    };
  }
}

async function handleCancelScript(executionId) {
  try {
    const execution = activeExecutions.get(executionId);

    if (!execution) {
      return { success: false, error: 'Execution not found' };
    }

    if (execution.status !== 'running') {
      return { success: false, error: 'Execution is not running' };
    }

    console.log(`Terminating script execution ${executionId} (tempId: ${execution.tempId})`);

    // COOPERATIVE CANCELLATION: Set the global flag that the script checks
    // This works reliably even with async/await code
    try {
      await chrome.scripting.executeScript({
        target: { tabId: execution.tabId },
        func: (tempId) => {
          window.__scriptCancellations = window.__scriptCancellations || {};
          window.__scriptCancellations[tempId] = true;
          console.log('Cooperative cancellation flag set for:', tempId);
        },
        args: [execution.tempId],
        world: 'MAIN'  // Execute in MAIN world where the script is running
      });
      console.log('Cooperative cancellation flag injected successfully');
    } catch (flagError) {
      console.error('Failed to inject cancellation flag:', flagError);
      // Continue anyway - V8 termination might still work
    }

    // ALSO call V8 termination as a backup (helps with synchronous code paths)
    // Note: This is unreliable with async/await, but cooperative flag above handles that
    try {
      await chrome.userScripts.terminate(executionId);
      console.log('V8 termination called successfully');
    } catch (v8Error) {
      console.error('V8 termination failed:', v8Error);
      // Don't fail the whole operation - cooperative cancellation is the primary mechanism
    }

    // Mark as terminated
    execution.status = 'terminated';
    execution.endTime = Date.now();

    console.log(`Script execution ${executionId} termination complete`);

    return { success: true, terminated: true };

  } catch (error) {
    console.error('Cancellation failed:', error);
    return { success: false, error: error.message };
  }
}

// Clean up old executions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, execution] of activeExecutions.entries()) {
    // Remove executions older than 5 minutes
    if (now - execution.startTime > 5 * 60 * 1000) {
      activeExecutions.delete(id);
    }
  }
}, 60000);

console.log('Script Cancellation Demo extension loaded');
