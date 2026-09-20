use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ForcedStopRequestFailure;

impl Display for ForcedStopRequestFailure {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "forced packaged runtime stop request failure")
    }
}

impl Error for ForcedStopRequestFailure {}

struct ObservedChild {
    cooperate_with_stop_request: bool,
    fail_stop_request: bool,
    kill_requested: Arc<AtomicBool>,
    stop_requested: Arc<AtomicBool>,
    stopped: mpsc::Sender<()>,
}

impl PackagedChild for ObservedChild {
    fn request_stop(&self) -> Result<(), Box<dyn Error + Send + Sync>> {
        if self.fail_stop_request {
            return Err(Box::new(ForcedStopRequestFailure));
        }
        self.stop_requested.store(true, Ordering::SeqCst);
        if self.cooperate_with_stop_request {
            self.stopped
                .send(())
                .expect("termination observer must remain available");
        }
        Ok(())
    }

    fn stop_now(self: Box<Self>) -> Result<(), Box<dyn Error + Send + Sync>> {
        self.kill_requested.store(true, Ordering::SeqCst);
        self.stopped
            .send(())
            .expect("termination observer must remain available");
        Ok(())
    }
}

fn observed_child(
    stopped: mpsc::Sender<()>,
    stop_requested: &Arc<AtomicBool>,
    kill_requested: &Arc<AtomicBool>,
) -> ObservedChild {
    ObservedChild {
        cooperate_with_stop_request: false,
        fail_stop_request: false,
        kill_requested: Arc::clone(kill_requested),
        stop_requested: Arc::clone(stop_requested),
        stopped,
    }
}

#[test]
fn normal_application_exit_stops_and_waits_for_the_registered_process() {
    let supervisor = PackageProcessSupervisor::new();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let kill_requested = Arc::new(AtomicBool::new(false));
    let (stopped_sender, stopped_receiver) = mpsc::channel();
    let events = supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            Ok((
                "events",
                observed_child(stopped_sender, &stop_requested, &kill_requested),
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
    assert!(kill_requested.load(Ordering::SeqCst));
    assert!(!stop_requested.load(Ordering::SeqCst));
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
fn graceful_stop_signals_first_and_waits_for_the_cooperative_child() {
    let supervisor = PackageProcessSupervisor::new();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let kill_requested = Arc::new(AtomicBool::new(false));
    let (stopped_sender, stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            let mut child = observed_child(stopped_sender, &stop_requested, &kill_requested);
            child.cooperate_with_stop_request = true;
            Ok(((), child))
        })
        .expect("the first child must register");

    let termination_supervisor = Arc::clone(&supervisor);
    let termination = thread::spawn(move || {
        stopped_receiver.recv().expect("graceful stop must arrive");
        termination_supervisor.record_termination()
    });
    assert!(
        supervisor
            .stop_gracefully(Duration::from_secs(5))
            .expect("a cooperative child must settle gracefully")
    );
    assert!(stop_requested.load(Ordering::SeqCst));
    assert!(!kill_requested.load(Ordering::SeqCst));
    assert!(
        !termination
            .join()
            .expect("termination observer must finish")
    );
}

#[test]
fn graceful_stop_escalates_to_a_kill_when_the_child_ignores_the_signal() {
    let supervisor = PackageProcessSupervisor::new();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let kill_requested = Arc::new(AtomicBool::new(false));
    let (stopped_sender, stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            Ok((
                (),
                observed_child(stopped_sender, &stop_requested, &kill_requested),
            ))
        })
        .expect("the first child must register");

    let termination_supervisor = Arc::clone(&supervisor);
    let termination = thread::spawn(move || {
        stopped_receiver.recv().expect("escalated kill must arrive");
        termination_supervisor.record_termination()
    });
    assert!(
        supervisor
            .stop_gracefully(Duration::from_millis(50))
            .expect("an uncooperative child must be killed after the grace window")
    );
    assert!(stop_requested.load(Ordering::SeqCst));
    assert!(kill_requested.load(Ordering::SeqCst));
    assert!(
        !termination
            .join()
            .expect("termination observer must finish")
    );
}

#[test]
fn graceful_stop_reports_a_failed_signal_and_still_kills_the_child() {
    let supervisor = PackageProcessSupervisor::new();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let kill_requested = Arc::new(AtomicBool::new(false));
    let (stopped_sender, stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            let mut child = observed_child(stopped_sender, &stop_requested, &kill_requested);
            child.fail_stop_request = true;
            Ok(((), child))
        })
        .expect("the first child must register");

    let termination_supervisor = Arc::clone(&supervisor);
    let termination = thread::spawn(move || {
        stopped_receiver.recv().expect("escalated kill must arrive");
        termination_supervisor.record_termination()
    });
    let failure = supervisor
        .stop_gracefully(Duration::from_secs(5))
        .expect_err("a failed stop request must surface its original cause");
    assert!(
        failure
            .to_string()
            .contains("Floway desktop could not stop and wait for its packaged runtime")
    );
    assert_eq!(
        failure
            .source()
            .expect("the stop failure chain must keep its cause")
            .to_string(),
        ForcedStopRequestFailure.to_string()
    );
    assert!(kill_requested.load(Ordering::SeqCst));
    assert!(
        !termination
            .join()
            .expect("termination observer must finish")
    );
}

#[test]
fn wait_terminated_observes_a_stop_settled_elsewhere() {
    let supervisor = PackageProcessSupervisor::new();
    let stop_requested = Arc::new(AtomicBool::new(false));
    let kill_requested = Arc::new(AtomicBool::new(false));
    let (stopped_sender, stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            let mut child = observed_child(stopped_sender, &stop_requested, &kill_requested);
            child.cooperate_with_stop_request = true;
            Ok(((), child))
        })
        .expect("the first child must register");

    let stop_supervisor = Arc::clone(&supervisor);
    let stopper = thread::spawn(move || stop_supervisor.stop_gracefully(Duration::from_secs(5)));
    let termination_supervisor = Arc::clone(&supervisor);
    let termination = thread::spawn(move || {
        stopped_receiver.recv().expect("graceful stop must arrive");
        termination_supervisor.record_termination()
    });
    assert!(supervisor.wait_terminated(Duration::from_secs(5)));
    assert!(
        stopper
            .join()
            .expect("stopper thread must finish")
            .expect("the cooperative child must settle")
    );
    assert!(
        !termination
            .join()
            .expect("termination observer must finish")
    );
}

#[test]
fn graceful_stop_without_a_child_is_a_no_op() {
    let supervisor = PackageProcessSupervisor::new();
    assert!(
        !supervisor
            .stop_gracefully(Duration::from_millis(1))
            .expect("an empty supervisor owns nothing to stop")
    );
    assert!(supervisor.wait_terminated(Duration::from_millis(1)));
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
fn repeated_registration_is_rejected_but_failure_recovery_can_spawn_after_termination() {
    let supervisor = PackageProcessSupervisor::new();
    let (stopped_sender, _stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            Ok((
                (),
                observed_child(
                    stopped_sender,
                    &Arc::new(AtomicBool::new(false)),
                    &Arc::new(AtomicBool::new(false)),
                ),
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
    let restarted = AtomicBool::new(false);
    let (restart_stopped_sender, _restart_stopped_receiver) = mpsc::channel();
    supervisor
        .spawn_registered(|| -> Result<_, ForcedSpawnFailure> {
            restarted.store(true, Ordering::SeqCst);
            Ok((
                (),
                observed_child(
                    restart_stopped_sender,
                    &Arc::new(AtomicBool::new(false)),
                    &Arc::new(AtomicBool::new(false)),
                ),
            ))
        })
        .expect("a failed runtime may be restarted explicitly");
    assert!(restarted.load(Ordering::SeqCst));
}
