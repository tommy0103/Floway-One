//! Owns the bounded failure-chain contract shared by the runtime and update surfaces.

// A cause's message is what the surface can show; its stack frames belong to
// the log, not to the operator's recovery view.
const FAILURE_CHAIN_MAXIMUM_ENTRIES: usize = 4;
const FAILURE_CHAIN_MAXIMUM_ENTRY_CHARS: usize = 400;

pub(crate) fn bounded_failure_chain(chain: &[String]) -> Vec<String> {
    chain
        .iter()
        .take(FAILURE_CHAIN_MAXIMUM_ENTRIES)
        .map(|entry| {
            entry
                .lines()
                .filter(|line| !line.trim_start().starts_with("at "))
                .flat_map(|line| line.chars().chain(std::iter::once('\n')))
                .filter(|character| !character.is_control() || *character == '\n')
                .take(FAILURE_CHAIN_MAXIMUM_ENTRY_CHARS)
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .filter(|entry| !entry.is_empty())
        .collect()
}
