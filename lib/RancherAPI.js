var request = require('request-promise-native');

var LOG = function () {
    var args = Array.prototype.slice.call(arguments);
    args.unshift((new Date()).toISOString());
    console.log.apply(this, args);
};

var ERROR = function (msg) {
    var args = Array.prototype.slice.call(arguments);
    args.unshift((new Date()).toISOString());
    console.error.apply(this, args);
    
    return Promise.reject(msg);
};

var DELAY = function (time) {
    return new Promise(function (fulfill) {
        setTimeout(fulfill, time);
    });
};

class RancherAPI {
    constructor (options) {
        if (!options) throw "options can't be null.";
        if (!options.endpoint) throw "you must specify a rancher endpoint.";
        if (!options.apikey) throw "you must specify a rancher api key.";
        if (!options.apisecret) throw "you must specify a rancher api secret.";
        
        // defaults
        options = Object.assign({
            statusCheckFrequency : 20 * 1000,
            serviceActiveTimeout : 3 * 60 * 1000,
            serviceUpgradedTimeout : 3 * 60 * 1000
        }, options);
        
        this.options = options;
    }
    
    _apiRequest (path, method, params) {
        params = params || {};
        
        var requestOptions = {
            method : method,
            
            uri : (path.match(/^https?:\/\//) ? path : (this.options.endpoint + '/' + path)),
            auth : {
                user : this.options.apikey,
                pass : this.options.apisecret
            },
            json :true
        };
        
        if (method === 'GET') {
            requestOptions.qs = params;
        } else {
            requestOptions.body = params;
        };
        
        return request(requestOptions).then(function (body) {
            return body;
        }).catch(function(err) {
            return console.log('ERROR on REQ:', err);
        });
    }
    
    get (path, params) {
        return this._apiRequest(path, 'GET', params);
    }
    
    post (path, params) {
        return this._apiRequest(path, 'POST', params);
    }
    
    getService (name) {
        var self = this;
        return this.get('services', { name : name })
            .then(function (result) {
                if (!result || !result.data || !result.data.length) return ERROR("getService: Rancher service not found.");
                var svc = result.data[0];
                return svc;
            });
    }
    
    
    /**
    * inServiceUpgrade
    * Does a rancher in-service upgrade
    *
    * Options as object
    *
    *   serviceName String Name of the service to upgrade.
    *   imageRepo   String Name of docker repo.
    *
    *   Optional:
    *   imageTag         String Tag of docker repo.
    *   environment      Object List of environment variables to change.
    *   batchSize        Number rancher batch size.
    *   intervalMillis   Number rancher interval between restarts.
    *   startFirst       Bool   rancher start before stop.
    *
    * Chain:
    *
    *   upgrade => waitForUpgrade => waitForActive
    *
    *   if successfull returns service object
    *
    */
    inServiceUpgrade (options) {
        // options validation
        options = options || {};
        if (!options.serviceName) return ERROR("Must specify options.serviceName");
        if (!options.imageRepo) return ERROR("Must specify options.imageRepo");
        
        // default
        options.environment = options.environment || {};
        if (typeof options.batchSize === 'undefined') { options.batchSize = 1 }
        if (typeof options.intervalMillis === 'undefined') { options.intervalMillis = 30*1000 }
        if (typeof options.startFirst === 'undefined') { options.startFirst = true }
        

        LOG('Starting deploy for', options.serviceName);
        var self = this;
        return this.getService(options.serviceName).then(function (svc) {
            LOG('Got service', options.serviceName);
            if (svc.state !== 'active' && !svc.actions.upgrade) {
                return ERROR('Service is not in active status. (' + svc.state + '). Cannot proceed.', svc);
            } else if (svc.state !== 'active') {
                LOG('Warning: service is not in active status. (' + svc.state + '). It seems we can proceed anyway...');
            }
            
            // update svc image uuid
            var uuid = 'docker:' + options.imageRepo;
            if (options.imageTag) { uuid += ':' + options.imageTag }
            
            svc.launchConfig.imageUuid = uuid,
            LOG('Changed service image uuid to', svc.launchConfig.imageUuid);
            
            svc.launchConfig.environment = Object.assign(svc.launchConfig.environment||{},options.environment);
            LOG('Updated service environment variables.');
            
            // post upgrade
            return self.post(svc.actions.upgrade, { 
                inServiceStrategy : {
                    batchSize : options.batchSize,
                    intervalMillis : options.intervalMillis,
                    startFirst : options.startFirst,
                    launchConfig : svc.launchConfig,
                    secondaryLaunchConfigs : svc.secondaryLaunchConfigs
                }
            });
        })
        .then(function (result) {
            LOG('Upgrading service...', result.state);
            return self.waitForUpgrade(options.serviceName);
        });
    }
    
    /**
     * waitForUpgrade
     *
     * Waits for upgrade to complete and if successful then triggers a finishupgrade
     */
    waitForUpgrade (serviceName, startTime) {
        var self = this,
            startTime = startTime || Date.now();
        
        // upgrade timeout...
        if (startTime + self.options.serviceUpgradedTimeout < Date.now()) {
            return ERROR( "Timeout waiting for service to upgrade. Upgrade failed!" );
        }
        
        return this.getService(serviceName).then(function (svc) {
            if (svc.state === 'upgrading') {
                LOG('Service is upgrading, waiting...');
                return DELAY(self.options.statusCheckFrequency).then(function () { 
                    return self.waitForUpgrade(serviceName, startTime)
                });
            } else if (svc.state === 'upgraded') {
                // success!
                LOG('Service is upgraded. Finishing...');
                return self.post(svc.actions.finishupgrade, {}).then(function(result) {
                    LOG('Finish upgrade sent.');
                    // now we wait for service to be active...
                    return self.waitForActive(serviceName);
                });
            } else {
                LOG('unexpected status', svc.state,'Aborting.');
                return ERROR( "unexpected status ("+ svc.state +") when waiting for upgrade to complete." );
            };
        });
    }
    
    
    /**
     * waitForActive
     *
     * Waits for service to be active.
     */
    waitForActive (serviceName, startTime) {
        var self = this,
            startTime = startTime || Date.now();
        
        // timeout
        if (startTime + self.options.serviceActiveTimeout < Date.now()) {
            return ERROR( "Timeout waiting for service to activate. Upgrade failed!" );
        }
        
        return this.getService(serviceName).then(function (svc) {
            if (svc.state !== 'active') {
                LOG('Waiting for active status. Current(' + svc.state + ')');
                return DELAY(self.options.statusCheckFrequency).then( function () { 
                    return self.waitForActive(serviceName, startTime);
                });
            } else {
                LOG('Upgrade succeded!');
                return svc;
            };
        });
    }

};

module.exports = RancherAPI;
