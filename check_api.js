// API Diagnostic Script
const results = document.getElementById('results');

function addResult(title, status, message, details = null) {
  const div = document.createElement('div');
  div.className = `status ${status}`;

  let html = `<strong>${title}:</strong> ${message}`;
  if (details) {
    html += `<pre>${details}</pre>`;
  }

  div.innerHTML = html;
  results.appendChild(div);
}

// Check chrome object
if (typeof chrome === 'undefined') {
  addResult('Chrome API', 'error', 'chrome object is not defined');
} else {
  addResult('Chrome API', 'success', 'chrome object is available');
}

// Check chrome.userScripts
if (typeof chrome.userScripts === 'undefined') {
  addResult('userScripts API', 'error',
    'chrome.userScripts is not defined',
    'Possible causes:\n' +
    '1. Feature flag ApiUserScriptsExecute is not enabled\n' +
    '2. Developer mode is not enabled at chrome://extensions\n' +
    '3. Extension does not have userScripts permission\n' +
    '4. Chrome needs to be rebuilt with latest changes'
  );
} else {
  addResult('userScripts API', 'success', 'chrome.userScripts is available');

  // Check available methods
  const methods = [];
  for (const key in chrome.userScripts) {
    if (typeof chrome.userScripts[key] === 'function') {
      methods.push(key);
    }
  }

  addResult('Available Methods', 'info',
    `Found ${methods.length} methods`,
    methods.join('\n')
  );

  // Check specific methods
  const expectedMethods = ['register', 'getScripts', 'unregister', 'update', 'execute', 'terminate', 'configureWorld', 'getWorldConfigurations', 'resetWorldConfiguration'];

  const missing = [];
  const present = [];

  for (const method of expectedMethods) {
    if (typeof chrome.userScripts[method] === 'function') {
      present.push(method);
    } else {
      missing.push(method);
    }
  }

  if (present.length > 0) {
    addResult('Present Methods', 'success',
      `${present.length} methods found`,
      present.join('\n')
    );
  }

  if (missing.length > 0) {
    addResult('Missing Methods', 'error',
      `${missing.length} methods missing`,
      missing.join('\n') + '\n\n' +
      'If terminate is missing:\n' +
      '1. Ensure Chrome was rebuilt after adding terminate to _api_features.json\n' +
      '2. Clear the test profile: rm -rf /tmp/chrome-test-profile\n' +
      '3. Restart Chrome with feature flags\n' +
      '4. Enable Developer Mode at chrome://extensions'
    );
  }
}

// Check permissions
chrome.permissions.getAll((permissions) => {
  const hasUserScripts = permissions.permissions.includes('userScripts');
  if (hasUserScripts) {
    addResult('Permissions', 'success', 'userScripts permission granted');
  } else {
    addResult('Permissions', 'error', 'userScripts permission NOT granted');
  }
});

// Try to check if feature flag is enabled
addResult('Feature Flag', 'info',
  'Check if ApiUserScriptsExecute is enabled',
  'Look for --enable-features=ApiUserScriptsExecute in chrome://version'
);

console.log('API diagnostic complete. Check results above.');
console.log('Chrome object:', chrome);
console.log('userScripts object:', chrome.userScripts);
