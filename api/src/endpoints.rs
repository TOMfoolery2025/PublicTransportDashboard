use gtfs_structures::Agency;
use rocket::{Rocket, Build, futures, post, get, delete, Error, Response, response};
use rocket::fairing::{self, AdHoc};
use rocket::response::status::{Created, NotFound};
use rocket::serde::{Serialize, Deserialize, json::Json};

use rocket_db_pools::{Database, Connection, sqlx};
use sqlx::query;

use rocket::http::Status;
use rocket::response::status;
use rocket::serde::json::serde_json;
use rocket_db_pools::sqlx::Row;
use rocket_db_pools::sqlx::sqlite::SqliteRow;
use crate::Transport;


#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
pub struct AgencyDTO {
    id: i64,
    name: String,
    url: String,
    timezone: String,
    lang: Option<String>,
}
#[get("/agency/<id>")]
pub async fn read(mut db: Connection<Transport>, id: i64) -> Result<Json<AgencyDTO>, Status> {
    let query = query("SELECT * FROM Agency WHERE agency_id=?")
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
