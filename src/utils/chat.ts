export type ChatSafety = {
  level: 'general' | 'review' | 'urgent';
  reasons: string[];
  verificationRecommended: boolean;
};

const URGENT_PATTERN = /nyeri dada|sesak napas|sulit bernapas|tidak sadar|pingsan|kejang|stroke|perdarahan hebat|bunuh diri|ingin mati|menyakiti diri|overdosis/i;
const REVIEW_PATTERN = /\bobat\b|dosis|interaksi|resep|hasil lab|laboratorium|diagnosis|insulin|antikoagulan/i;

export function evaluateChatSafety(userMessage: string, assistantContent: string): ChatSafety {
  const combined = `${userMessage}\n${assistantContent}`;
  if (URGENT_PATTERN.test(combined)) {
    return { level: 'urgent', reasons: ['possible_emergency'], verificationRecommended: true };
  }
  if (REVIEW_PATTERN.test(combined)) {
    return {
      level: 'review',
      reasons: ['medication_or_diagnostic_advice'],
      verificationRecommended: true,
    };
  }
  return { level: 'general', reasons: [], verificationRecommended: false };
}
