use rocket::{launch, routes};
use rocket_db_pools::{sqlx, Database};
#[derive(Database)]
#[database("transport")]
struct Transport(sqlx::SqlitePool);
mod endpoints;
mod liveupdates;

use dotenvy::dotenv;
use std::env;
use std::sync::Arc;
use dashmap::DashMap;
use neo4rs::Graph;
use crate::liveupdates::{update_listener, UpdateStore};
// Define the struct with the #[database("name")] attribute

#[launch]
async fn rocket() -> _ {
    dotenv().ok();
    let graph = Graph::new(
                env::var("NEO4J_URI").expect("NEO4J_URI must be set"),
                env::var("NEO4J_USER").expect("NEO4J_USER must be set"),
                env::var("NEO4J_PASSWORD").expect("NEO4J_PASSWORD must be set"),
            ).expect("Failed to create Neo4j Graph instance");
    let updates = Arc::new(UpdateStore::new());
    tokio::spawn(update_listener(Arc::clone(&updates)));

    rocket::build()
        // Attach the initializer fairing
        .attach(Transport::init())
        .manage(graph)
        .manage(Arc::clone(&updates))
        .mount("/", routes![
            endpoints::agency_by_id, endpoints::all_stops, endpoints::departures_at_stop,
            endpoints::all_stops_for_trip, endpoints::get_stop_by_id
        ])
}