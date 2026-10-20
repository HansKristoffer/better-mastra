export {
	type AppStateLike,
	type AudioApiModule,
	appStateLifecycle,
	audioApiMicrophone,
	DICTATION_BUFFER_SAMPLES,
	DICTATION_SAMPLE_RATE,
	mediaRecorderMicrophone,
	webSocketFactory
} from './adapters.js'
export {
	applySonioxResponse,
	buildSonioxStartRequest,
	type DictationTranscript,
	EMPTY_TRANSCRIPT,
	type SonioxAudioFormat,
	type SonioxResponseResult,
	sonioxLanguageHints,
	toS16le,
	transcriptText
} from './protocol.js'
export {
	DICTATION_FINISH_TIMEOUT_MS,
	type DictationAudio,
	type DictationEnd,
	type DictationFrame,
	type DictationKey,
	type DictationLifecycle,
	type DictationMicrophone,
	type DictationOptions,
	type DictationSession,
	type DictationSocket,
	type DictationSocketFactory,
	type DictationStart,
	startDictation
} from './session.js'
