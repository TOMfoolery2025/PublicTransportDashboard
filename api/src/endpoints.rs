use chrono::Local;
use chrono_tz::Europe::Berlin;
use gtfs_structures::Agency;
use neo4rs::{query, Graph};
use rocket::{Rocket, Build, futures, post, get, delete, Error, Response, response, State};
use rocket::fairing::{self, AdHoc};
use rocket::response::status::{Created, NotFound};
use rocket::serde::{Serialize, Deserialize, json::Json};

use rocket_db_pools::{Database, Connection, sqlx};

use rocket::http::Status;
use rocket::response::status;
use rocket::serde::json::serde_json;
use rocket_db_pools::sqlx::Row;
use rocket_db_pools::sqlx::sqlite::SqliteRow;
use crate::{Transport};


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
    departure_time: String,
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
pub async fn departures_at_stop(mut db: Connection<Transport>, stop_id: i64)
    -> Result<Json<Vec<TripDTO>>, Status> {
    let now_local = Local::now();
    let cest_time = now_local.with_timezone(&Berlin);
    let current_time: String = cest_time.format("%H:%M:%S").to_string();
    let query = sqlx::query(
        "SELECT Trips.trip_id, Trips.route_id, Trips.service_id,
       Routes.route_short_name, StopTimes.departure_time
        FROM StopTimes
        JOIN Trips ON StopTimes.trip_id = Trips.trip_id
        JOIN Routes ON Trips.route_id = Routes.route_id
        WHERE StopTimes.stop_id = ? AND StopTimes.departure_time >= ?
        ORDER BY StopTimes.departure_time
        LIMIT 10;"
    )
        .bind(stop_id)
        .bind(current_time)
        .fetch_all(&mut **db)
        .await;
    if let Ok(rows) = query {
        let mut trips: Vec<TripDTO> = Vec::new();
        for row in rows {
            let trip = TripDTO {
                trip_id: row.get::<i64, _>("trip_id"),
                route_id: row.get::<i64, _>("route_id"),
                service_id: row.get::<i64, _>("service_id"),
                route_short_name: row.get::<String, _>("route_short_name"),
                departure_time: row.get::<String, _>("departure_time"),
            };
            trips.push(trip);
        }
        Ok(Json(trips))
    } else {
        Err(Status::InternalServerError)
    }
}