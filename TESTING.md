# Testing the Script Cancellation Demo

This guide explains how to test the `chrome.userScripts.execute()` and `terminate()` APIs.

## Prerequisites

1. **Build Chrome** with the latest changes from this feature implementation
2. The build must include:
   - `userScripts.execute()` API implementation
   - `userScripts.terminate()` API implementation
   - `ApiUserScriptsExecute` feature flag (enabled by default)

## Launch Command

Run Chrome from the chromium/src directory with the following command:

```bash
cd /home/chrome/chromium/src

./out/Default/chrome \
  --user-data-dir=/tmp/chrome-test-profile \
  --load-extension=/home/chrome/script_cancel_demo \
  --enable-features=ApiUserScriptsExecute \
  --enable-logging=stderr \
  --v=1 \
  --no-first-run \
  --no-default-browser-check \
  "https://example.com"
```

Or use the test script:

```bash
~/test_script_cancel_with_flags.sh
```

## Enable Developer Mode

1. Navigate to `chrome://extensions`
2. Toggle "Developer mode" in the top right
3. Verify the extension is loaded (look for "User Script Cancellation Demo")

## Testing Steps

### 1. Basic Script Execution

1. Click the extension icon (⚡) in the toolbar
2. Keep the default duration (10000ms = 10 seconds)
3. Click "Run Script"
4. You should see:
   - A green box appear on the page saying "Script running..."
   - The execution listed in the popup with status "RUNNING"
   - A countdown showing remaining time

### 2. Script Cancellation

1. Click "Run Script" again with a long duration (e.g., 30000ms)
2. While the script is running, click "Cancel Execution" in the popup
3. You should see:
   - The green box turn red saying "Script terminated!"
   - The execution status change to "TERMINATED"
   - The script stops immediately

### 3. Automatic Timeout

1. Click "Run Script" with duration 40000ms (40 seconds)
2. Wait without cancelling
3. After 30 seconds (default timeout), the script should automatically terminate
4. Check the browser console for timeout messages

### 4. Multiple Concurrent Executions

1. Open the extension popup
2. Click "Run Script" multiple times in quick succession
3. You should see multiple executions listed
4. Try cancelling individual executions
5. Verify each can be cancelled independently

## Debugging

### Check if API is Available

Open the extension's background page console:
1. Go to `chrome://extensions`
2. Find "User Script Cancellation Demo"
3. Click "background page" under "Inspect views"
4. In the console, type: `chrome.userScripts`
5. You should see an object with `execute` and `terminate` methods

### Common Issues

**Issue**: "chrome.userScripts.execute API is not available"

**Solutions**:
- Ensure you launched Chrome with `--enable-features=ApiUserScriptsExecute`
- Verify Developer Mode is enabled at `chrome://extensions`
- Rebuild Chrome with: `autoninja -C out/Default chrome`
- Check that `extensions/common/api/_api_features.json` includes `userScripts.terminate`

**Issue**: Script doesn't stop when cancelled

**Solutions**:
- Check browser console for errors
- Verify V8 termination is working: `--vmodule=script_injection*=2`
- Look for "Terminating script execution" log messages

### Verbose Logging

For detailed debugging, launch with extra flags:

```bash
./out/Default/chrome \
  --user-data-dir=/tmp/chrome-test-profile \
  --load-extension=/home/chrome/script_cancel_demo \
  --enable-features=ApiUserScriptsExecute \
  --enable-logging=stderr \
  --v=2 \
  --vmodule=user_scripts*=2,script_injection*=2,script_executor*=2 \
  --no-first-run \
  --no-default-browser-check
```

## Expected Log Output

When running and cancelling a script, you should see logs like:

```
Starting script execution b4c38f13-c9e8-4983-bc1a-faeb6952fea9 for 10000ms
Terminating script execution b4c38f13-c9e8-4983-bc1a-faeb6952fea9
Script execution b4c38f13-c9e8-4983-bc1a-faeb6952fea9 terminated successfully
```

## Architecture Testing Points

1. **Browser Process**: UserScriptsExecutionTracker manages timeouts
2. **IPC**: Browser → Renderer via TerminateScriptExecution mojo call
3. **Renderer Process**: ScriptInjectionManager → v8::Isolate::TerminateExecution()
4. **Extension**: Receives termination error callback

## Success Criteria

✅ Scripts execute for the specified duration
✅ Scripts can be cancelled mid-execution
✅ Scripts timeout automatically after 30 seconds
✅ Multiple scripts can run and be cancelled independently
✅ Visual feedback shows script status correctly
✅ No crashes or hung renderers

## Reporting Issues

If you encounter problems:
1. Collect verbose logs (see above)
2. Note the exact steps to reproduce
3. Check if the issue is in browser-side or renderer-side
4. File a bug with logs and reproduction steps
