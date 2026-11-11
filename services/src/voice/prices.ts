/**
 * AWS list prices in Sydney (ap-southeast-2), in integer micro-dollars. Transcribe streaming is $0.0001667 a second,
 * billed by the second with no minimum; it is rounded up here so the budget never counts less than AWS bills. Polly's
 * neural voices are $16 per million characters.
 */
const TRANSCRIBE_MICROS_PER_SEC = 167;
const POLLY_NEURAL_MICROS_PER_CHAR = 16;

export const transcribeMicros = (seconds: number) => seconds * TRANSCRIBE_MICROS_PER_SEC;
export const speechMicros = (chars: number) => chars * POLLY_NEURAL_MICROS_PER_CHAR;
