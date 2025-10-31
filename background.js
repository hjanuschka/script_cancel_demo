// Map to track active script executions (minimal tracking for UI only)
const activeExecutions = new Map();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'executeScript') {
    handleExecuteScript(message.demoCase, message.duration).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'cancelScript') {
    handleCancelScript(message.tabId).then(sendResponse);
    return true;
  } else if (message.action === 'getActiveExecutions') {
    sendResponse(Array.from(activeExecutions.values()));
    return false;
  }
});

async function handleExecuteScript(demoCase, duration) {
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

    // Generate script code based on demo case
    let scriptCode;

    if (demoCase === 'syncLoop') {
      // Case 1: Sync loop with setTimeout yields (works with V8 termination)
      scriptCode = `
        (async function() {
          const startTime = Date.now();
          const duration = ${duration};

          console.log('Sync loop demo started, duration: ' + duration + 'ms');

          // Create visual indicator
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
          indicator.textContent = '🔄 Sync loop starting...';
          document.body.appendChild(indicator);

          await new Promise(resolve => setTimeout(resolve, 50));

          let counter = 0;

          // Sync loop that yields via setTimeout
          while (Date.now() - startTime < duration) {
            const elapsed = Date.now() - startTime;
            const remaining = duration - elapsed;

            // Do some work (5ms worth)
            const workUntil = Date.now() + 5;
            while (Date.now() < workUntil) {
              counter++;
            }

            // Update UI
            indicator.textContent = '🔄 Sync loop: ' + Math.round(remaining) + 'ms left (count: ' + counter + ')';

            // Yield to event loop (macrotask) - allows V8 termination
            await new Promise(resolve => setTimeout(resolve, 0));
          }

          // Completed successfully
          indicator.style.background = '#2196F3';
          indicator.textContent = '✅ Sync loop completed! Count: ' + counter;

          setTimeout(() => {
            indicator.remove();
          }, 3000);

          return { success: true, iterations: counter };
        })();
      `;
    } else if (demoCase === 'asyncChain') {
      // Case 2: Async fetch chain (yields naturally, works with V8 termination)
      scriptCode = `
        (async function() {
          const startTime = Date.now();
          const duration = ${duration};

          console.log('Async chain demo started, duration: ' + duration + 'ms');

          // Create visual indicator
          const indicator = document.createElement('div');
          indicator.id = 'script-cancel-demo-indicator';
          indicator.style.cssText = \`
            position: fixed;
            top: 10px;
            left: 10px;
            background: #9C27B0;
            color: white;
            padding: 15px;
            border-radius: 5px;
            z-index: 999999;
            font-family: Arial, sans-serif;
            font-size: 16px;
            font-weight: bold;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
          \`;
          indicator.textContent = '⚡ Async chain starting...';
          document.body.appendChild(indicator);

          await new Promise(resolve => setTimeout(resolve, 50));

          let chainCount = 0;

          // Simulate async operations chain
          while (Date.now() - startTime < duration) {
            const elapsed = Date.now() - startTime;
            const remaining = duration - elapsed;

            indicator.textContent = '⚡ Async chain: ' + Math.round(remaining) + 'ms left (chains: ' + chainCount + ')';

            // Simulate fetch chain with delays (yields naturally)
            await Promise.resolve()
              .then(() => new Promise(resolve => setTimeout(resolve, 100)))
              .then(() => {
                // Simulate processing
                return { data: 'chunk_' + chainCount };
              })
              .then(result => {
                // Simulate more processing
                chainCount++;
                return result;
              })
              .then(() => new Promise(resolve => setTimeout(resolve, 50)));
          }

          // Completed successfully
          indicator.style.background = '#673AB7';
          indicator.textContent = '✅ Async chain completed! Chains: ' + chainCount;

          setTimeout(() => {
            indicator.remove();
          }, 3000);

          return { success: true, chains: chainCount };
        })();
      `;
    } else {
      return { success: false, error: 'Unknown demo case: ' + demoCase };
    }

    // Generate a unique execution ID that we'll pass to execute()
    // This gives us a "handle" to the execution before it even starts!
    const executionId = crypto.randomUUID();
    const trackingId = `${tab.id}_${Date.now()}`;

    // Store minimal execution info for UI tracking BEFORE executing
    // This ensures it shows up immediately in the UI, and we already have the executionId!
    activeExecutions.set(trackingId, {
      trackingId,
      tabId: tab.id,
      executionId,  // Store it immediately!
      demoCase,
      startTime: Date.now(),
      duration,
      status: 'running'
    });

    console.log(`Script execution starting on tab ${tab.id}, tracking ID: ${trackingId}, executionId: ${executionId}`);

    // Execute the script with our pre-generated executionId
    // Now we can terminate it immediately without waiting for the callback!
    chrome.userScripts.execute({
      target: { tabId: tab.id },
      js: [{ code: scriptCode }],
      world: 'MAIN',
      executionId: executionId  // Pass our handle!
    }).then(results => {
      console.log(`Script execution completed on tab ${tab.id}`, results);

      const execution = activeExecutions.get(trackingId);
      if (execution) {
        // Verify the returned executionId matches what we sent
        if (results && results.length > 0 && results[0].executionId) {
          console.log(`Execution completed with ID: ${results[0].executionId} (matches: ${results[0].executionId === executionId})`);
        }

        execution.status = 'completed';
        execution.endTime = Date.now();
      }
    }).catch(error => {
      console.error(`Script execution failed on tab ${tab.id}:`, error);
      const execution = activeExecutions.get(trackingId);
      if (execution) {
        execution.status = 'failed';
        execution.endTime = Date.now();
        execution.error = error.message;
      }
    });

    // Return immediately so UI updates right away
    return {
      success: true,
      trackingId,
      tabId: tab.id
    };

  } catch (error) {
    console.error('Script execution failed:', error);

    return {
      success: false,
      error: error.message
    };
  }
}

async function handleCancelScript(tabId) {
  try {
    // Find the running execution on this tab
    let executionToTerminate = null;
    for (const [id, execution] of activeExecutions.entries()) {
      if (execution.tabId === tabId && execution.status === 'running') {
        executionToTerminate = execution;
        break;
      }
    }

    if (!executionToTerminate) {
      return { success: false, error: 'No running execution found on this tab' };
    }

    if (!executionToTerminate.executionId) {
      return { success: false, error: 'Execution ID not yet available (script may still be starting)' };
    }

    console.log(`Calling chrome.userScripts.terminate(${tabId}, "${executionToTerminate.executionId}")`);

    const result = await chrome.userScripts.terminate(tabId, executionToTerminate.executionId);

    console.log(`Termination call completed for execution ${executionToTerminate.executionId}, result:`, result);

    // Mark execution as terminated (for UI only)
    executionToTerminate.status = 'terminated';
    executionToTerminate.endTime = Date.now();

    return { success: true, terminated: result, executionId: executionToTerminate.executionId };

  } catch (error) {
    console.error('Termination failed:', error);
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
