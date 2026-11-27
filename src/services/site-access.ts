import type { Participant } from '../protocols/domain';
import { domProfiles } from '../adapters/dom/profiles';

/** Invoke directly from a click/Enter handler; Chrome owns the first-use authorization. */
export function requestModelSiteAccess(
  participants: Pick<Participant, 'platform' | 'websiteUrl'>[],
): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return Promise.resolve(true);
  const origins = [
    ...new Set(
      participants.flatMap((participant) => {
        const origin = new URL(participant.websiteUrl).origin;
        return domProfiles.some(
          (profile) => profile.id === participant.platform && profile.origins.includes(origin),
        )
          ? [`${origin}/*`]
          : [];
      }),
    ),
  ];
  return origins.length ? chrome.permissions.request({ origins }) : Promise.resolve(true);
}
