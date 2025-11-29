use std::fmt::format;
use std::sync::Arc;
use chrono::{Datelike, Local, TimeZone};
use chrono_tz::Europe::Berlin;
use dashmap::DashSet;
use gtfs_structures::Agency;
use neo4rs::{query, BoltLocalDateTime, Graph};
use neo4rs::BoltType::DateTime;
use rocket::{Rocket, Build, futures, post, get, delete, Error, Response, response, State};
use rocket::fairing::{self, AdHoc};
use rocket::futures::TryFutureExt;
use rocket::response::status::{Created, NotFound};
use rocket::serde::{Serialize, Deserialize, json::Json};

use rocket_db_pools::{Database, Connection, sqlx};

use rocket::http::Status;
use rocket::response::status;
use rocket::serde::json::serde_json;
use rocket_db_pools::sqlx::{Execute, Row};
use rocket_db_pools::sqlx::sqlite::SqliteRow;
use crate::{Transport};
use crate::liveupdates::{update_listener, Departure, Update, UpdateStore};

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
pub struct AgencyDTO {
    id: i64,
    name: String,
    url: String,
    timezone: String,
    lang: Option<String>,
}


#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
pub struct StopGraphDTO {
    stop_id: i64,
    stop_name: String,
    stop_lat: f64,
    stop_lon: f64,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
pub struct TripDTO {
    trip_id: i64,
    route_id: i64,
    service_id: i64,
    route_short_name: String,
    departure_timestamp: i64,
    delay: i32,
    live: bool
}


#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
pub struct StopDTO {
    sequence: i64,
    stop_id: i64,
    stop_name: String,
    stop_lat: f64,
    stop_lon: f64,
}


#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
pub struct TripStatusDTO {
    trip_id: i64,
    status: String,
    last_passed_stop_id: Option<i64>,
    next_stop_id: Option<i64>,
    canceled: bool,
}

#[derive(Serialize)]
pub struct FullStopInfoDTO {
    stop_id: i64,
    stop_name: String,
    parent_station: Option<i64>,
    stop_lat: f64,
    stop_lon: f64,
    location_type: Option<String>,
    platform_code: Option<String>,
}

#[get("/agency/<id>")]
pub async fn agency_by_id(mut db: Connection<Transport>, id: i64) -> Result<Json<AgencyDTO>, Status> {
    let query = sqlx::query("SELECT * FROM Agency WHERE agency_id=?")
        .bind(id)
        .fetch_one(&mut **db)
        .await;
    if let Ok(row) = query {
        let agency = AgencyDTO {
            id: row.get::<i64, _>("agency_id"),
            name: row.get::<String, _>("agency_name"),
            url: row.get::<String, _>("agency_url"),
            timezone: row.get::<String, _>("agency_timezone"),
            lang: row.get::<Option<String>, _>("agency_lang"),
        };
        Ok(Json(agency))
    } else {
        Err(Status::NotFound)
    }
}

#[get("/stops/<id>")]
pub async fn get_stop_by_id(mut db: Connection<Transport>, id: i64)
    -> Result<Json<FullStopInfoDTO>, Status> {
    let query = sqlx::query(
        "SELECT stop_id, stop_name, parent_station, stop_lat, stop_lon,
        location_type, platform_code
        FROM Stops WHERE stop_id = ?;"
    )
        .bind(id)
        .fetch_one(&mut **db)
        .await;
    if let Ok(row) = query {
        let parent_station: Option<i64> = row.try_get("parent_station").unwrap_or(None);
        let stop_info = FullStopInfoDTO {
            stop_id: row.get::<i64, _>("stop_id"),
            stop_name: row.get::<String, _>("stop_name"),
            parent_station: parent_station,
            stop_lat: row.get::<f64, _>("stop_lat"),
            stop_lon: row.get::<f64, _>("stop_lon"),
            location_type: row.get::<Option<String>, _>("location_type"),
            platform_code: row.get::<Option<String>, _>("platform_code"),
        };
        Ok(Json(stop_info))
    } else {
        Err(Status::NotFound)
    }
}

#[get("/stops")]
pub async fn all_stops(graph_database: &State<Graph>) -> Result<Json<Vec<StopGraphDTO>>, Status> {
    let result = graph_database.execute(
        query("MATCH(s:Stop) RETURN s;")
    ).await;
    if let Ok(mut result) = result {
        let mut vec: Vec<StopGraphDTO> = Vec::new();
        while let Ok(Some(row)) = result.next().await {
            if let Ok(node) = row.get::<neo4rs::Node>("s") {
                let stop_id = node.get::<String>("stop_id")
                    .expect("stop_id not found").parse().expect("stop_id not a number");
                let name = node.get::<String>("name")
                    .expect("stop_name not found");
                let lon = node.get::<f64>("lon").expect("stop_lon not found");
                let lat = node.get::<f64>("lat").expect("stop_lat not found");
                vec.push(StopGraphDTO {
                    stop_id,
                    stop_name: name,
                    stop_lat: lat,
                    stop_lon: lon,
                });
            }
        }
        Ok(Json(vec))
    } else {
        Err(Status::InternalServerError)
    }
}

#[get("/departures/<stop_id>")]
pub async fn departures_at_stop(mut db: Connection<Transport>,
                                mut update_store: &State<Arc<UpdateStore>>,
                                stop_id: i64) -> Result<Json<Vec<TripDTO>>, Status> {
    let now_local = Local::now();
    let cest_time = now_local.with_timezone(&Berlin);
    let time_string = cest_time.format("%H:%M:%S").to_string();
    let mut trips: Vec<TripDTO> = Vec::new();
    // Query offline stops first considering calender as well;
    let current_weekday = cest_time.weekday();
    let SQL_SUBCLAUSE = "(Calendar.{weekday} = 1)";
    let weekday_clause = match current_weekday {
        chrono::Weekday::Mon => SQL_SUBCLAUSE.replace("{weekday}", "monday"),
        chrono::Weekday::Tue => SQL_SUBCLAUSE.replace("{weekday}", "tuesday"),
        chrono::Weekday::Wed => SQL_SUBCLAUSE.replace("{weekday}", "wednesday"),
        chrono::Weekday::Thu => SQL_SUBCLAUSE.replace("{weekday}", "thursday"),
        chrono::Weekday::Fri => SQL_SUBCLAUSE.replace("{weekday}", "friday"),
        chrono::Weekday::Sat => SQL_SUBCLAUSE.replace("{weekday}", "saturday"),
        chrono::Weekday::Sun => SQL_SUBCLAUSE.replace("{weekday}", "sunday"),
    };
    let query = format!("SELECT Trips.trip_id, Trips.route_id, Trips.service_id,
        StopTimes.departure_time,
        Routes.route_short_name
        FROM StopTimes
        JOIN Trips ON StopTimes.trip_id = Trips.trip_id
        JOIN Routes ON Trips.route_id = Routes.route_id
        LEFT JOIN Calendar ON Trips.service_id = Calendar.service_id
        WHERE StopTimes.stop_id = ?
        AND StopTimes.departure_time >= ?
        AND {}
        ORDER BY StopTimes.departure_time
        LIMIT 10;", weekday_clause);

    let query_prep = sqlx::query(
        query.as_str()
    ).bind(stop_id)
        .bind(time_string)

        .bind(cest_time.format("%Y%m%d").to_string())
        .bind(cest_time.format("%Y%m%d").to_string());
    let query = query_prep
        .fetch_all(&mut **db)
        .await;
    let scheduled_departures_option = update_store.scheduled_departures.get(&stop_id);
    if let Ok(rows) = query {
        for row in rows {
            let trip_id = row.get::<i64, _>("trip_id");
            let live_data_option = scheduled_departures_option.as_ref().
                and_then(|scheduled_departures| {
                scheduled_departures.iter()
                    .find(|departure| departure.trip_id == trip_id)
            });
            let (departure_timestamp, delay, live) =
                if let Some(live_departure) = live_data_option {
                    let updated_timestamp = live_departure.departure.timestamp;
                    (updated_timestamp, live_departure.departure.delay, true)
                } else {
                    let departure_time_string = row.get::<String, _>("departure_time");
                    let departure_time_parts: Vec<&str> = departure_time_string.split(':')
                        .collect();
                    let today_cest = cest_time.date().and_hms(
                        departure_time_parts[0].parse().unwrap_or(0),
                        departure_time_parts[1].parse().unwrap_or(0),
                        departure_time_parts[2].parse().unwrap_or(0),
                    );
                    (today_cest.timestamp(), 0 , false)
                };
            let trip = TripDTO {
                trip_id,
                route_id: row.get::<i64, _>("route_id"),
                service_id: row.get::<i64, _>("service_id"),
                route_short_name: row.get::<String, _>("route_short_name"),
                departure_timestamp,
                delay,
                live,
            };
            trips.push(trip);
        }
    }
    trips.sort_by_key(|t| t.departure_timestamp);
    if trips.len() > 10 {
        trips.truncate(10);
    }
    Ok(Json(trips))
}



#[get("/trips/allStops/<trip_id>")]
pub async fn all_stops_for_trip(mut db: Connection<Transport>, trip_id: i64) -> Result<Json<Vec<StopDTO>>, Status> {
    let query = sqlx::query(
        "SELECT StopTimes.stop_sequence, Stops.stop_id, Stops.stop_name,
        Stops.stop_lat, Stops.stop_lon
        FROM StopTimes
        JOIN Stops ON StopTimes.stop_id = Stops.stop_id
        WHERE StopTimes.trip_id = ?
        ORDER BY StopTimes.stop_sequence;"
    )
        .bind(trip_id)
        .fetch_all(&mut **db)
        .await;
    if let Ok(rows) = query {
        let mut stops: Vec<StopDTO> = Vec::new();
        for row in rows {
            let stop = StopDTO {
                sequence: row.get::<i64, _>("stop_sequence"),
                stop_id: row.get::<i64, _>("stop_id"),
                stop_name: row.get::<String, _>("stop_name"),
                stop_lat: row.get::<f64, _>("stop_lat"),
                stop_lon: row.get::<f64, _>("stop_lon"),
            };
            stops.push(stop);
        }
        Ok(Json(stops))
    } else {
        Err(Status::InternalServerError)
    }
}

#[get("/live/trip/<trip_id>")]
pub async fn live_trip_info(update_store: &State<Arc<UpdateStore>>, trip_id: i64)
    -> Result<Json<Update>, Status> {
    let trip_status_option = update_store.trip_updates.get(&trip_id);
    if let Some(trip_status) = trip_status_option {
        Ok(Json(trip_status.clone()))
    } else {
        Err(Status::NotFound)
    }
}