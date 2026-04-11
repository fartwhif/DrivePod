#!/bin/bash
echo "🚀 Starting frontend deployment..."

# Go to frontend folder
cd /root/drivepod/frontend

echo "Building Angular app..."
ng build --configuration production

if [ $? -ne 0 ]; then
  echo "❌ Build failed!"
  exit 1
fi

echo "Copying build to web directory..."
sudo rm -rf /var/www/drivepod/*
sudo cp -r dist/frontend/browser/* /var/www/drivepod/

echo "Setting correct permissions..."
sudo chown -R www-data:www-data /var/www/drivepod
sudo chmod -R 755 /var/www/drivepod

echo "Restarting Nginx..."
sudo systemctl restart nginx

echo "✅ Frontend deployment completed successfully!"
echo "🌐 You can now refresh http://hostname-or-ip-address"
