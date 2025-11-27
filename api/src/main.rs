use rocket::{launch, routes};
use rocket_db_pools::{sqlx, Database};
#[derive(Database)]
#[database("transport")]
struct Transport(sqlx::SqlitePool);
mod endpoints;

// Define the struct with the #[database("name")] attribute

#[launch]
fn rocket() -> _ {
    println!("{:#?}", std::env::current_dir().unwrap());
    rocket::build()
        // Attach the initializer fairing
        .attach(Transport::init())
        .mount("/", routes![
            endpoints::read
        ])
}