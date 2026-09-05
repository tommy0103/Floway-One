use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;

#[allow(dead_code)]
#[path = "../../src/sidecar_supervisor.rs"]
mod sidecar_supervisor;

use sidecar_supervisor::{PackageProcessSupervisor, PackagedChild, ProcessRegistrationError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ForcedSpawnFailure;

impl Display for ForcedSpawnFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "forced packaged runtime spawn failure")
    }
}

impl Error for ForcedSpawnFailure {}

struct ObservedChild {
    stop_requested: Arc<AtomicBool>,
    stopped: mpsc::Sender<()>,
}

impl PackagedChild for ObservedChild {
    fn stop_now(self: Box<Self>) -> Result<(), Box<dyn Error + Send + Sync>> {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.stopped
            .send(())
            .expect("termination observer must remain available");
        Ok(())
    }
}

#[test]
fn normal_application_exit_stops_and_waits_for_the_registered_process() {
    let supervisor = PackageProcessSupervisor::new();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let (stopped_sender, stopped_receiver) = mpsc::channel();
    let events = supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            Ok((
                "events",
                ObservedChild {
                    stop_requested: Arc::clone(&stop_requested),
                    stopped: stopped_sender,
                },
            ))
        })
        .expect("the first child must register");
    assert_eq!(events, "events");

    let termination_supervisor = Arc::clone(&supervisor);
    let termination = thread::spawn(move || {
        stopped_receiver.recv().expect("stop request must arrive");
        termination_supervisor.record_termination()
    });
    assert!(
        supervisor
            .stop_now()
            .expect("normal app exit must stop its child")
    );
    assert!(stop_requested.load(Ordering::SeqCst));
    assert!(
        !termination
            .join()
            .expect("termination observer must finish")
    );
    assert!(
        !supervisor
            .stop_now()
            .expect("stopped child must remain stopped")
    );
}

#[test]
fn spawn_failure_preserves_its_original_cause_and_ownership_remains_empty() {
    let supervisor = PackageProcessSupervisor::new();
    let failure = supervisor
        .spawn_registered(|| -> Result<((), ObservedChild), ForcedSpawnFailure> {
            Err(ForcedSpawnFailure)
        })
        .expect_err("forced spawn failure must surface");
    assert!(matches!(
        failure,
        ProcessRegistrationError::Spawn(ForcedSpawnFailure)
    ));
    assert_eq!(
        failure.source().unwrap().to_string(),
        ForcedSpawnFailure.to_string()
    );
    assert!(!supervisor.stop_now().expect("a failed spawn owns no child"));
}

#[test]
fn repeated_or_late_registration_is_rejected_without_spawning_another_process() {
    let supervisor = PackageProcessSupervisor::new();
    let (stopped_sender, _stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            Ok((
                (),
                ObservedChild {
                    stop_requested: Arc::new(AtomicBool::new(false)),
                    stopped: stopped_sender,
                },
            ))
        })
        .expect("the first child must register");
    let second_spawned = AtomicBool::new(false);
    let failure = supervisor
        .spawn_registered(|| -> Result<((), ObservedChild), ForcedSpawnFailure> {
            second_spawned.store(true, Ordering::SeqCst);
            unreachable!("a second process must not spawn")
        })
        .expect_err("a second registration must fail");
    assert!(matches!(failure, ProcessRegistrationError::AlreadyOwned));
    assert!(!second_spawned.load(Ordering::SeqCst));

    assert!(supervisor.record_termination());
    let late_spawned = AtomicBool::new(false);
    let failure = supervisor
        .spawn_registered(|| -> Result<((), ObservedChild), ForcedSpawnFailure> {
            late_spawned.store(true, Ordering::SeqCst);
            unreachable!("a late process must not spawn")
        })
        .expect_err("registration after termination must fail");
    assert!(matches!(failure, ProcessRegistrationError::AlreadyOwned));
    assert!(!late_spawned.load(Ordering::SeqCst));
}
