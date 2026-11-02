/** The rejection for a wait cut short by an `AbortSignal`, recognised by omp and the DOM as an abort. */
export function abortError(): DOMException {
	return new DOMException("aborted", "AbortError");
}
