'use strict';
// Classify in memory. Persist only fixed descriptions and conservative codes,
// never arbitrary provider text (which may echo prompts or credentials).
const descriptions = {
 revoked: ['Proxy access revoked', 'Generate a new proxy API key in the local dashboard to restore access.'],
 disabled: ['Channel disabled', 'Enable this channel in Channels and configure a provider API key.'],
 stream: ['Stream ended before completion', 'The upstream stream ended without a completion marker. Check provider connectivity and retry manually if appropriate.'],
 auth: ['Credential rejected', 'Check the stored provider key, its expiry, and its permissions.'],
 proxy_auth: ['Proxy token rejected', 'Use the existing proxy token for local API requests. Provider keys are separate.'],
 restricted: ['Account access restricted', 'Check the provider account status. Changing request parameters will not unlock an account.'],
 quota: ['Quota or credit exhausted', 'Check provider credits, billing, and the account quota.'],
 rate_limit: ['Provider rate limit', 'Wait before sending another request, or reduce concurrent requests.'],
 headers: ['Required conversation header missing', 'Review the provider’s required headers and session settings.'],
 not_found: ['Model or endpoint unavailable', 'Check the model ID, base URL, and the provider catalog.'],
 invalid: ['Request rejected', 'Review model support and request parameters, including stream and output limits.'],
 too_large: ['Request too large', 'Reduce the prompt/context size or review the gateway body limit.'],
 unavailable: ['Provider unavailable', 'Check provider status and enabled channels. Retry manually when it recovers.'],
 timeout: ['Request timed out', 'The provider did not respond in time. Check connectivity and the model’s response time.'],
 dns: ['Provider DNS lookup failed', 'Check the upstream hostname and VPS DNS resolution.'],
 network: ['Upstream connection failed', 'Check the provider URL, network connection, and TLS configuration.'],
 cancelled: ['Connection interrupted', 'The client stopped reading or a stream disconnected. Partial output may have arrived.'],
 upstream: ['Upstream returned an error', 'Check the HTTP status and provider error code, then review provider availability.'],
 legacy: ['Earlier error; details unavailable', 'This request predates the error inspector. New failures include a diagnosis.'],
};
function diagnose(status, input, source='upstream') {
 let parsed=input;
 if(typeof input==='string'){try{parsed=JSON.parse(input);}catch{parsed={};}}
 const err=parsed?.error || parsed || {};
 const text=String(err.message||parsed?.message||'').toLowerCase();
 const rawCode=String(err.code??err.type??'');
 const knownCode=/^(?:[A-Z][A-Z_0-9]{1,40}|[a-z][a-z_]{1,40}|[0-9]{1,8})$/.test(rawCode)?rawCode:null;
 let kind='upstream';
 if(source==='proxy'&&/revoked/.test(text))kind='revoked';
 else if(source==='proxy'&&/disabled/.test(text))kind='disabled';
 else if(rawCode==='stream_incomplete')kind='stream';
 else if(source==='proxy'&&status===401)kind='proxy_auth';
 else if(status===499)kind='cancelled';
 else if(rawCode==='ENOTFOUND'||rawCode==='EAI_AGAIN')kind='dns';
 else if(status===408||status===504||/TIMEOUT|TIMEDOUT/.test(rawCode))kind='timeout';
 else if(/restricted|suspended|banned|unusual activity/.test(text)||rawCode==='11140')kind='restricted';
 else if(/conversation.{0,30}(missing|required)|missing.{0,30}conversation/.test(text))kind='headers';
 else if(status===402||/quota|credit|balance|billing|budget/.test(text))kind='quota';
 else if(status===429||/rate.limit|too many requests/.test(text))kind='rate_limit';
 else if(status===401||status===403)kind='auth';
 else if(status===404)kind='not_found';
 else if(status===413)kind='too_large';
 else if(status===400||status===422)kind='invalid';
 else if(status===503)kind='unavailable';
 else if(source==='network')kind='network';
 const [message,hint]=descriptions[kind];
 // Persist numeric codes or known generic error types, not arbitrary key-shaped values.
 const code=knownCode&&(/^[0-9]+$/.test(knownCode)||/^(?:E[A-Z_]+|[a-z]+_error|invalid_api_key|insufficient_quota|rate_limit_exceeded|model_not_found|context_length_exceeded|stream_incomplete)$/.test(knownCode))?knownCode:null;
 return { kind, message, hint, code, source };
}
function legacyDiagnosis(status){if(status<400)return null;return{kind:'legacy',message:descriptions.legacy[0],hint:descriptions.legacy[1],source:'unknown',code:null};}
module.exports={diagnose,legacyDiagnosis};
