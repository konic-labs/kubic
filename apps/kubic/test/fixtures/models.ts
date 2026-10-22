// A model catalog built from a models.json body.
import {
  createModels,
  type fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';

// Regression reproductions, end to end through `kubic run`'s headless
// path (faux provider, zero network): each of these bash calls must ask,
// never exit 0 with no ask.
export function modelsWith(
  steps: ReturnType<typeof fauxAssistantMessage>[],
): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}
