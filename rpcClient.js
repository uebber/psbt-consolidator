// rpcClient.js
import logger from './logger.js';

// Basic Authentication header
function getAuthHeader(user, password) {
  if (!user || !password) return {};
  const credentials = Buffer.from(`${user}:${password}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

// Helper to construct the correct RPC URL (with or without wallet context)
function getRpcUrl(config, walletName = null) {
    let url = config.bitcoinCore.rpcUrl;
    if (walletName) {
        // Ensure no double slashes if rpcUrl already ends with /
        const separator = url.endsWith('/') ? '' : '/';
        url = `${url}${separator}wallet/${encodeURIComponent(walletName)}`;
    }
    return url;
}


async function makeRpcCall(config, method, params = [], walletName = null) {
  const url = getRpcUrl(config, walletName);
  const requestId = Date.now(); // Simple request ID

  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method: method,
    params: params,
  };

  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeader(config.bitcoinCore.rpcUser, config.bitcoinCore.rpcPassword),
  };

  logger.trace(`RPC Request (${requestId}) to ${url}:`, { method, params: (method === 'importdescriptors' ? '[REDACTED]' : params) }); // Avoid logging sensitive data like descriptors if needed

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
    });

    // Log raw response text for deep debugging if needed
    // const responseText = await response.text();
    // logger.trace(`RPC Raw Response Text (${requestId}):`, responseText);
    // const data = JSON.parse(responseText); // Parse after logging raw text

    const data = await response.json();
    logger.trace(`RPC Response (${requestId}):`, data);


    if (!response.ok) {
      // Handle HTTP errors (e.g., 401 Unauthorized, 404 Not Found)
      const errorMessage = data?.error?.message || `HTTP Error: ${response.status} ${response.statusText}`;
      throw new Error(`RPC HTTP Error: ${errorMessage} (URL: ${url}, Method: ${method})`);
    }

    if (data.error) {
      // Handle errors reported within the JSON-RPC response
      throw new Error(`RPC Error: ${data.error.message} (Code: ${data.error.code}, Method: ${method})`);
    }

    if (data.id !== requestId) {
        logger.warn(`RPC Response ID mismatch. Request: ${requestId}, Response: ${data.id}`);
        // Decide if this is critical - usually not, but good to log.
    }

    return data.result;

  } catch (error) {
    logger.error(`RPC Call Failed: ${error.message}`, { url, method, params: (method === 'importdescriptors' ? '[REDACTED]' : params) });
    if (error instanceof SyntaxError) {
        // Handle cases where the response wasn't valid JSON
        throw new Error(`Failed to parse RPC response as JSON. Is Bitcoin Core running and reachable at ${url}?`);
    }
    // Re-throw the original or wrapped error
    throw error;
  }
}

export { makeRpcCall };
