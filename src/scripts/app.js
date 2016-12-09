define(["TFS/WorkItemTracking/Services", "TFS/WorkItemTracking/RestClient", "q", "VSS/Controls", "VSS/Controls/StatusIndicator", "VSS/Controls/Dialogs"],
    function(_WorkItemServices, _WorkItemRestClient, Q, Controls, StatusIndicator, Dialogs) {

        function getWorkItemFormService() {
            return _WorkItemServices.WorkItemFormService.getService();
        }

        function getApiUrl(method) {
            var ctx = VSS.getWebContext();
            var collection = ctx.collection.uri;
            var project = ctx.project.name;
            var team = ctx.team.name;

            var url = collection + project + '/' + team + '/_apis/wit' + method;
            return url;
        }

        function callRestApi(method) {

            return VSS.getAccessToken()
                .then(function(accessToken) {

                    var url = getApiUrl(method);
                    return $.ajax({
                        url: url,
                        dataType: 'json',
                        headers: {
                            'Authorization': 'Basic ' + btoa("" + ":" + accessToken.token)
                        }
                    })
                });
        }

        function getTemplates(workItemTypes) {

            var requests = []
            workItemTypes.forEach(function(workItemType) {

                var request = callRestApi('/templates?workItemTypeName=' + workItemType);
                requests.push(request);
            }, this);

            return Q.all(requests)
                .then(function(templateTypes) {

                    var templates = [];
                    templateTypes.forEach(function(templateType) {
                        if (templateType.count > 0) {

                            templateType.value.forEach(function(element) {
                                templates.push(element)
                            }, this);
                        }
                    }, this);
                    return templates;
                });
        }

        function getTemplate(id) {
            return callRestApi('/templates/' + id);
        }

        function createWorkItemFromTemplate(currentWorkItem, taskTemplate) {
            var workItem = [];

            for (var key in taskTemplate.fields) {
                if (taskTemplate.fields.hasOwnProperty(key)) {
                    if (key.indexOf('System.Tags') == -1) { //not supporting tags for now
                        workItem.push({ "op": "add", "path": "/fields/" + key, "value": taskTemplate.fields[key] })
                    }
                }
            }

            if (taskTemplate.fields['System.Title'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.Title", "value": currentWorkItem['System.Title'] })

            if (taskTemplate.fields['System.AreaPath'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.AreaPath", "value": currentWorkItem['System.AreaPath'] })

            if (taskTemplate.fields['System.IterationPath'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": currentWorkItem['System.IterationPath'] })

            if (taskTemplate.fields['System.AssignedTo'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.AssignedTo", "value": currentWorkItem['System.AssignedTo'] })

            return workItem;
        }

        function createWorkItem(service, currentWorkItem, taskTemplate) {

            var newWorkItem = createWorkItemFromTemplate(currentWorkItem, taskTemplate);

            _WorkItemRestClient.getClient().createWorkItem(newWorkItem, VSS.getWebContext().project.name, taskTemplate.workItemTypeName)
                .then(function(response) {
                    //Add relation
                    service.addWorkItemRelations([
                        {
                            rel: "System.LinkTypes.Hierarchy-Forward",
                            url: response.url,
                        }]);
                    //Save 
                    service.beginSaveWorkItem(function(response) {
                        //WriteLog(" Saved");
                    }, function(error) {
                        ShowDialog(" Error saving: " + response);
                    });
                });
        }

        function AddChilds(service) {
            // Get the current values for a few of the common fields
            service.getFieldValues(["System.Id", "System.Title", "System.State", "System.CreatedDate", "System.IterationPath", "System.AreaPath", "System.AssignedTo", "System.RelatedLinkCount", "System.WorkItemType"])
                .then(function(value) {
                    var currentWorkItem = value

                    var childTypes = GetChildTypes(currentWorkItem["System.WorkItemType"]);
                    if (childTypes == null)
                        return;
                    // get Templates
                    getTemplates(childTypes)
                        .then(function(response) {
                            if (response.length == 0) {
                                ShowDialog(workItemType + ' Templates found: ' + response.count + '. Please add ' + workItemType + ' templates to the Project Team.')
                            }
                            // Create child task
                            response.forEach(function(template) {

                                getTemplate(template.id).then(function(taskTemplate) {
                                    createWorkItem(service, currentWorkItem, taskTemplate)
                                });
                            }, this);
                        })
                })
        }

        function GetChildTypes(workItemType) {
            if (workItemType == 'Epic') {
                return ['Feature']
            }
            if (workItemType == 'Feature') {
                return ['Product Backlog Item', 'User Story', 'Requirement', 'Bug']
            }
            if (workItemType == 'Product Backlog Item') {
                return ['Task']
            }
            if (workItemType == 'User Story') {
                return ['Task']
            }
            if (workItemType == 'Requirement') {
                return ['Task']
            }
            if (workItemType == 'Bug') {
                return ['Task']
            }
            if (workItemType == 'Task') {
                return ['Task']
            }
            WriteLog(workItemType + ' not supported.')
            return null;
        }

        function ShowDialog(message) {

            var dialogOptions = {
                title: "1-Click Child-Links",
                width: 300,
                height: 200,
                resizable: false,
            };

            VSS.getService(VSS.ServiceIds.Dialog).then(function(dialogSvc) {

                dialogSvc.openMessageDialog(message, dialogOptions)
                    .then(function(dialog) {
                        //
                    }, function(dialog) {
                        //
                    });
            });
        }

        function WriteLog(msg) {
            console.log('1-Click Child-Links: ' + msg);
        }

        return {

            create: function(context) {
                getWorkItemFormService().then(function(service) {
                    WriteLog("Init");
                    AddChilds(service)
                })
            },

        }
    });