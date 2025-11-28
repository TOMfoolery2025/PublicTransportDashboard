cargo build --release
cp target/release/api ./api_production
chmod +x ./api_production
echo "Production build completed: ./api_production"