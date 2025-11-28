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

