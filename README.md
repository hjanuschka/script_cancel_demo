# User Script Cancellation Demo Extension

This Chrome extension demonstrates the new `chrome.userScripts.execute()` and `chrome.userScripts.terminate()` APIs for executing and cancelling long-running scripts.

## Features

- **Execute Long-Running Scripts**: Run scripts that simulate long-running operations (configurable duration: 1-60 seconds)
- **Real-Time Cancellation**: Terminate running scripts immediately using the `terminate()` API
- **Visual Feedback**: See script execution status directly on the page with a visual indicator
- **Execution Tracking**: View all active script executions with their status
- **Automatic Timeout**: Scripts automatically timeout after 30 seconds if not completed

## APIs Demonstrated

### `chrome.userScripts.execute()`
Executes a script with a unique execution ID that can be used for later cancellation:

```javascript
const result = await chrome.userScripts.execute({
  target: { tabId: tab.id },
  func: scriptCode,
  world: 'MAIN',
  executionId: executionId  // Unique ID for tracking
});
```

### `chrome.userScripts.terminate()`
Terminates a running script by its execution ID:

```javascript
const terminated = await chrome.userScripts.terminate(executionId);
```

## Installation

1. Clone this repository or download the source code
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension directory
5. The extension icon will appear in your toolbar

## Usage

1. Click the extension icon to open the popup
2. Set the script duration (in milliseconds)
3. Click "Run Script" to start executing a long-running script
4. A visual indicator will appear on the page showing the script is running
5. In the popup, you'll see the execution listed with a "Cancel" button
6. Click "Cancel Execution" to terminate the script mid-execution
7. The visual indicator will update to show the script was terminated

## Technical Details

### Script Execution Flow

1. The popup sends a message to the service worker to execute a script
2. The service worker generates a unique execution ID (UUID)
3. The script is injected into the active tab using `userScripts.execute()`
4. The script creates a visual indicator and runs a simulation loop
5. The execution is tracked in the service worker's active executions map

### Termination Flow

1. User clicks "Cancel" in the popup
2. The popup sends a termination message to the service worker
3. The service worker calls `chrome.userScripts.terminate(executionId)`
4. V8 terminates the script execution in the renderer process
5. The visual indicator is updated to show termination status

### Implementation Architecture

- **Browser Process**: Manages execution tracking, timeouts, and IPC
- **Renderer Process**: Executes scripts and handles V8 termination
- **Extension**: Provides UI and demonstrates the APIs

## Browser Support

This extension requires Chromium with the userScripts cancellation feature implemented (Chromium 130+).

## License

This is a demonstration extension for educational purposes.

## Contributing

This extension demonstrates an experimental API. Please report issues or suggestions via GitHub issues.
