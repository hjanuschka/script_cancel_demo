// DOM elements
const durationInput = document.getElementById('duration');
const executeBtn = document.getElementById('executeBtn');
const statusDiv = document.getElementById('status');
const executionsDiv = document.getElementById('executions');

// Current execution tracking
let currentExecutionId = null;
let currentTabId = null;

// Execute script button handler
executeBtn.addEventListener('click', async () => {
  const duration = parseInt(durationInput.value);
  const demoCase = document.querySelector('input[name="demoCase"]:checked').value;

  if (duration < 1000 || duration > 60000) {
    showStatus('Please enter a duration between 1000ms and 60000ms', 'error');
    return;
  }

  executeBtn.disabled = true;
  const caseName = demoCase === 'syncLoop' ? 'sync loop (setTimeout)' : 'async fetch chain';
  showStatus(`Starting ${caseName}...`, 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'executeScript',
      demoCase: demoCase,
      duration: duration
    });

    if (response.success) {
      currentExecutionId = response.trackingId;
      currentTabId = response.tabId;
      showStatus(
        `Script started! (tab ${response.tabId})`,
        'success'
      );

      // Refresh executions list
      refreshExecutions();

      // Start polling for updates
      startPolling();
    } else {
      if (response.terminated) {
        showStatus('Script was terminated', 'error');
      } else {
        showStatus(`Error: ${response.error}`, 'error');
      }
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    executeBtn.disabled = false;
  }
});

// Show status message
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.classList.remove('hidden');

  // Auto-hide after 5 seconds for success/info messages
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      statusDiv.classList.add('hidden');
    }, 5000);
  }
}

// Refresh executions list
async function refreshExecutions() {
  try {
    const executions = await chrome.runtime.sendMessage({
      action: 'getActiveExecutions'
    });

    if (executions.length === 0) {
      executionsDiv.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #999;">
          No active executions
        </div>
      `;
      return;
    }

    executionsDiv.innerHTML = executions.map(exec => {
      const elapsed = exec.endTime
        ? exec.endTime - exec.startTime
        : Date.now() - exec.startTime;

      const caseName = exec.demoCase === 'syncLoop' ? 'Sync Loop' : 'Async Chain';

      return `
        <div class="execution">
          <div class="execution-header">
            <span class="execution-id">Tab ${exec.tabId} - ${caseName}</span>
            <span class="execution-status ${exec.status}">${exec.status.toUpperCase()}</span>
          </div>
          <div class="execution-details">
            Duration: ${exec.duration}ms | Elapsed: ${elapsed}ms
          </div>
          ${exec.status === 'running' ? `
            <button class="danger cancel-btn" style="margin-top: 8px; width: 100%;"
                    data-tab-id="${exec.tabId}">
              Terminate (Tab ${exec.tabId})
            </button>
          ` : ''}
        </div>
      `;
    }).join('');

    // Add event listeners to cancel buttons
    document.querySelectorAll('.cancel-btn').forEach(button => {
      button.addEventListener('click', () => {
        const tabId = parseInt(button.getAttribute('data-tab-id'));
        cancelExecution(tabId);
      });
    });
  } catch (error) {
    console.error('Failed to refresh executions:', error);
  }
}

// Cancel execution - SIMPLIFIED: just pass tabId
async function cancelExecution(tabId) {
  try {
    showStatus(`Calling terminate(${tabId})...`, 'info');

    const response = await chrome.runtime.sendMessage({
      action: 'cancelScript',
      tabId: tabId
    });

    if (response.success) {
      showStatus(`✅ Terminated tab ${tabId}!`, 'success');
      refreshExecutions();
    } else {
      showStatus(`Failed to terminate: ${response.error}`, 'error');
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  }
};

// Polling for execution updates
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  pollingInterval = setInterval(async () => {
    await refreshExecutions();

    // Stop polling if no running executions
    const executions = await chrome.runtime.sendMessage({
      action: 'getActiveExecutions'
    });

    const hasRunning = executions.some(e => e.status === 'running');
    if (!hasRunning) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }, 500);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// Initial load
refreshExecutions();

// Clean up on popup close
window.addEventListener('unload', () => {
  stopPolling();
});
