// Map to track active script executions
const activeExecutions = new Map();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'executeScript') {
    handleExecuteScript(message.duration).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.action === 'cancelScript') {
    handleCancelScript(message.executionId).then(sendResponse);
    return true;
  } else if (message.action === 'getActiveExecutions') {
    sendResponse(Array.from(activeExecutions.values()));
    return false;
  }
});

async function handleExecuteScript(duration) {
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

    // Execute a long-running script
    const scriptCode = `
      (async function() {
        const startTime = Date.now();
        const duration = ${duration};

        console.log('Script started, will run for ' + duration + 'ms');

        // Create a visual indicator
        const indicator = document.createElement('div');
        indicator.id = 'script-cancel-demo-indicator';
        indicator.style.cssText = \`
          position: fixed;
          top: 10px;
          right: 10px;
          background: #4CAF50;
          color: white;
          padding: 15px;
          border-radius: 5px;
          z-index: 999999;
          font-family: Arial, sans-serif;
          box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        \`;
        indicator.textContent = 'Script running... (' + duration + 'ms)';
        document.body.appendChild(indicator);

        // Simulate long-running work
        let counter = 0;
        while (Date.now() - startTime < duration) {
          counter++;

          // Update indicator every 100ms
          if (counter % 100 === 0) {
            const elapsed = Date.now() - startTime;
            const remaining = duration - elapsed;
            indicator.textContent = 'Script running... ' + remaining + 'ms remaining';
          }

          // Yield to allow termination
          if (counter % 1000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        // Script completed successfully
        indicator.style.background = '#2196F3';
        indicator.textContent = 'Script completed successfully!';

        setTimeout(() => {
          indicator.remove();
        }, 2000);

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

    console.log(`Script execution started with ID ${executionId}`);

    // Store execution info
    activeExecutions.set(executionId, {
      executionId,
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

    console.log(`Terminating script execution ${executionId}`);

    // Terminate the script execution
    const terminated = await chrome.userScripts.terminate(executionId);

    if (terminated) {
      execution.status = 'terminated';
      execution.endTime = Date.now();

      // Update visual indicator in the page
      await chrome.scripting.executeScript({
        target: { tabId: execution.tabId },
        func: () => {
          const indicator = document.getElementById('script-cancel-demo-indicator');
          if (indicator) {
            indicator.style.background = '#f44336';
            indicator.textContent = 'Script terminated!';
            setTimeout(() => indicator.remove(), 2000);
          }
        }
      });

      console.log(`Script execution ${executionId} terminated successfully`);

      return { success: true, terminated: true };
    } else {
      return { success: false, error: 'Failed to terminate script' };
    }

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
