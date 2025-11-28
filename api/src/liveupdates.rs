use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Europe::Berlin;
use dashmap::{DashMap, DashSet};
use prost::Message;
use rocket::build;
use rocket::futures::channel::oneshot::Canceled;
use serde::{Deserialize, Serialize};
use crate::liveupdates::gtfs::FeedMessage;
use crate::liveupdates::gtfs::trip_update::stop_time_update::ScheduleRelationship::Skipped;

pub mod gtfs {
    include!(concat!(env!("OUT_DIR"), "/transit_realtime.rs"));
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GTFSTime {

    pub delay: i32,
    pub timestamp: i64
}

impl GTFSTime {
    pub(crate) fn clone(&self) -> GTFSTime {
        GTFSTime {
            delay: self.delay,
            timestamp: self.timestamp
        }
    }
    pub fn to_string(&self) -> String{
        let time = Berlin.timestamp_opt(self.timestamp, 0);
        match time {
            chrono::LocalResult::Single(dt) => dt.format("%H:%M:%S").to_string(),
            _ => "Invalid Time".to_string(),
        }
    }

    pub fn is_in_past(&self) -> bool {
        let now = Utc::now().with_timezone(&Berlin);
        self.timestamp < now.timestamp()
    }

    pub fn is_in_future(&self) -> bool {
        !self.is_in_past()
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ScheduledStop {
    pub stop_sequence: u32,
    pub arrival: GTFSTime,
    pub departure: GTFSTime,
    pub canceled: bool
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Update {
    pub trip_id: i64,
    pub start_date: String,
    pub next_stop_index: i64,
    pub stops: Vec<ScheduledStop>,
    pub canceled: bool
}


pub struct Departure {
    pub trip_id: i64,
    pub start_date: String,
    pub arrival: GTFSTime,
    pub departure: GTFSTime,
    pub cancelled: bool,
}

impl std::hash::Hash for Departure {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.trip_id.hash(state);
    }
}

impl PartialEq for Departure {
    fn eq(&self, other: &Self) -> bool {
        self.trip_id == other.trip_id
    }
}
impl Eq for Departure {}

pub struct UpdateStore {
    pub trip_updates: DashMap<i64, Update>,
    // Maps bus stop IDs to scheduled trips arriving at that stop
    pub scheduled_departures: DashMap<i64, DashSet<Departure>>,
}

impl UpdateStore {
    pub fn new() -> Self {
        UpdateStore {
            trip_updates: DashMap::new(),
            scheduled_departures: DashMap::new()
        }
    }
}

pub async fn update_listener(update_store: Arc<UpdateStore>) {
    let gtfs_url = "https://realtime.gtfs.de/realtime-free.pb";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300)).build()
        .unwrap();

    let mut last_modified: Option<DateTime<Utc>> = None;

    let mut etag: Option<String> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let start_time = Utc::now();
        let mut client = client.get(gtfs_url).header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
            Chrome/58.0.3029.110 Safari/537.3"
        );

        if let Some(last_modified) = last_modified {
            client = client.header(
                "If-Modified-Since",
                last_modified.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
            );
        }
        if let Some(etag) = &etag {
            client = client.header("If-None-Match", etag);
        }
        let response = client.send().await;
        if response.is_err() {
            println!("Failed to fetch GTFS data: {}", response.err().unwrap());
            continue;
        }
        // Print Status code
        println!("GTFS data fetched with status: {}", response.as_ref().unwrap().status());
        last_modified = Some(Utc::now());
        etag = response.as_ref().unwrap().headers().get("ETag")
            .and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        let bytes = response.unwrap().bytes().await;

        if bytes.is_err() {
            println!("Failed to read GTFS data bytes: {}", bytes.err().unwrap());
            continue;
        }
        let feed = FeedMessage::decode(bytes.unwrap().as_ref());
        if feed.is_err() {
            println!("Failed to decode GTFS feed: {}", feed.err().unwrap());
            continue;
        }
        for entity in &feed.as_ref().unwrap().entity {
            if let Some(trip_update) = &entity.trip_update {
                let trip_id: i64 = trip_update.trip.trip_id.as_ref()
                    .expect("Trip ID is Faulty in the update")
                    .parse().unwrap_or(-1);
                if trip_id == -1 {
                    continue;
                }
                let start_date = trip_update.trip.start_date.clone().unwrap();
                let mut stops: Vec<ScheduledStop> = Vec::new();
                for stop_time_update in &trip_update.stop_time_update {
                    let stop_sequence = stop_time_update.stop_sequence.expect(
                        "Faulty stop sequence in trip update"
                    );
                    let arrival = if let Some(arrival) =
                        &stop_time_update.arrival {
                        GTFSTime {
                            delay: arrival.delay.unwrap_or(0),
                            timestamp: arrival.time.expect("Arrival time missing"),
                        }
                    } else {
                        GTFSTime { delay: 0, timestamp: 0 }
                    };
                    let departure = if let Some(departure) =
                        &stop_time_update.departure {
                        GTFSTime {
                            delay: departure.delay.unwrap_or(0),
                            timestamp: departure.time.expect("Departure time missing"),
                        }
                    } else {
                        GTFSTime { delay: 0, timestamp: 0 }
                    };
                    let canceled = stop_time_update.schedule_relationship
                        .unwrap_or(i32::from(Skipped)) == i32::from(Skipped);
                    let stop_id = stop_time_update.stop_id.as_ref()
                        .expect("Stop ID missing in stop time update")
                        .parse::<i64>()
                        .expect("Stop ID invalid in stop time update");

                    let stop_departure = Departure {
                        trip_id,
                        start_date: start_date.clone(),
                        arrival: arrival.clone(),
                        departure: departure.clone(),
                        cancelled: canceled
                    };

                    stops.push(ScheduledStop {
                        stop_sequence,
                        arrival,
                        departure,
                        canceled
                    });

                    if update_store.scheduled_departures.contains_key(&stop_id) {
                        let departures =
                            update_store.scheduled_departures.get_mut(&stop_id).unwrap();
                        if departures.contains(&stop_departure) {
                            departures.remove(&stop_departure);
                        }
                        departures.insert(stop_departure);
                    } else {
                        update_store.scheduled_departures.insert(
                            stop_id,
                            {
                                let set = DashSet::new();
                                set.insert(stop_departure);
                                set
                            }
                        );
                    }
                }
                let update_canceled = stops.iter().all(|s| s.canceled);
                let update = Update {
                    trip_id,
                    start_date,
                    next_stop_index: 0,
                    stops,
                    canceled: update_canceled
                };
                update_store.trip_updates.insert(trip_id, update);
            }
        }
        update_store.trip_updates.retain(|_k, v| {
            if let Some(last_stop) = v.stops.last() {
                last_stop.departure.is_in_future()
            } else {
                false
            }
        });

        update_store.scheduled_departures.retain(|_k, v| {
            v.retain(|departure| departure.departure.is_in_future());
            !v.is_empty()
        });
        // Clean up old scheduled departures



        let feed_message = feed.unwrap();
        println!("GTFS Feed has {} entities", feed_message.entity.len());
        println!("Took {} ms to process feed", (Utc::now() - start_time).num_milliseconds());
    }
}