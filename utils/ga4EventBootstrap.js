import { serializeForInlineScript } from './serializeForInlineScript.js';

export function consumeGa4Event(session) {
  const event = session.__GA4_EVENT__ || null;
  delete session.__GA4_EVENT__;
  return serializeForInlineScript(event);
}
